import { create } from "zustand";
import { exceedsAvailableBalance, exceedsPaymentCeiling, isZeroBaseUnits, MAX_PAYMENT_BASE_UNITS, parseCashInputToBaseUnits } from "@/lib/real/payments/amount";
import { formatCashBaseUnits } from "@/lib/real/display/cash";
import { REAL_CASH_TOKEN } from "@/lib/real/constants";
import { signPreparedPayment } from "@/lib/real/payments/client-sign";
import { hasEnoughValidityToDispatch } from "@/lib/real/payments/validity";
import { isWebAuthnCancellation } from "@/lib/real/signing/passkey";
import type { WirePreparedFields } from "@/lib/real/payments/prepared-operation";
import { ownHandleMessage, resolveRecipientView, type RecipientLookup, type RecipientView } from "@/lib/real/recipient-input";
import type { PaymentRecipientIdentity } from "@/lib/real/display/payment-recipient";
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
  /**
   * Slice D: the server's stored snapshot of who a handle payment was
   * addressed to; null for an address payment. Every response that returns
   * the attempt carries it, so it is the ONE source of the recipient's name
   * after prepare (and after a reload). Shown only through
   * lib/real/display/payment-recipient.ts, which validates it first; never
   * sent back to the server.
   */
  recipientIdentity: PaymentRecipientIdentity | null;
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
  /**
   * Slice C: the advisory @name lookup for the CURRENT recipientInput — any
   * edit resets it to idle. It never routes money: prepare re-resolves the
   * handle on the server, and no address or account id is ever kept here.
   */
  recipientLookup: RecipientLookup;
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
  /**
   * 3A-1 Stage 2A: true while the manual "Check status" action is cooling
   * down (MANUAL_CHECK_COOLDOWN_MS after a press). Flipped by a store timer —
   * never derived from Date.now() in a component render.
   */
  isManualCheckCoolingDown: boolean;
  /**
   * 3A-1 Stage 2A: true once the bounded automatic follow-up sequence for the
   * current attempt has run out. It says only that the page stopped asking by
   * itself — never that the payment failed or was cancelled. The manual
   * "Check status" action remains.
   */
  isFollowUpExhausted: boolean;
  /**
   * 3A-1 Stage 2C-2: the server answered the last status read with "not now"
   * (reconciliationDeferred) — the stored attempt was returned untouched and no
   * provider was asked. It says nothing about the payment: not confirmed, not
   * failed, not cancelled. Cleared by a settled answer, a new lifecycle, or
   * when the retry deadline passes.
   */
  isStatusDeferred: boolean;
  /** The server's validated delay for that deferral, in whole seconds; null when none (or an unusable one — a local fallback deadline is then in force). */
  statusRetryAfterSeconds: number | null;
  /**
   * 3A-2 Stage 2: the server refused THIS submit because the account's submit
   * budget is spent. It was decided before any provider work: nothing was sent
   * and nothing changed, so the payment is exactly as it was (still waiting for
   * approval) and the same approval may be sent again once the wait is over.
   * True only while the wait runs; flipped by a store timer, never derived from
   * Date.now() in a render. The wait ending only re-enables the manual action —
   * nothing is ever sent automatically.
   */
  isSubmitCoolingDown: boolean;
  /** Whole seconds the wait was (about) when it was set or restored — for plain-language copy only; null when there is none. */
  submitCooldownSeconds: number | null;
  /**
   * True when the wait ends too late for this approval to still be dispatched
   * (judged with the same validity margin the server enforces). The approval
   * is then not offered again: Cancel and the existing expiry/recovery paths
   * remain. It says nothing about the payment having failed.
   */
  isSubmitRetryBeyondApproval: boolean;
  /** Reload/restore: never signs, never submits, never resends — see server/payments.ts's resolveLatestPayment. */
  init: () => Promise<void>;
  setRecipientInput: (value: string) => void;
  setAmountInput: (value: string) => void;
  /** Recipient field blur: looks up an @name that hasn't been checked yet. Never called per keystroke; a no-op for an address, a malformed name, or the account's own name. */
  lookupRecipient: () => Promise<void>;
  /** Synchronous for an address or an already-found @name. An unchecked @name is looked up first, and review opens only if it is found. */
  review: () => Promise<void>;
  editAgain: () => void;
  /** Fresh flow: prepare -> sign -> submit, from the "reviewing" status. */
  confirmAndSend: () => Promise<void>;
  /** Resume flow after a reload finds a still-awaiting_authorization attempt: sign -> submit for the SAME persisted attempt, never a new one. */
  resumeAuthorization: () => Promise<void>;
  /** Abandons an awaiting_authorization attempt so it stops occupying the account's one-active-attempt slot. */
  cancel: () => Promise<void>;
  /** The manual "Check status" action: cooldown-limited, and joins any status request already in flight for the attempt. */
  checkStatus: () => Promise<void>;
  /** The one automatic check after a payment becomes (or is restored as) submitted. Waits while the page is hidden; at most once per attempt. */
  checkSubmittedStatus: () => Promise<void>;
  /** Fed by the Pay form from `document.visibilityState`. While hidden, no automatic check starts and the follow-up timer is suspended. */
  setPageVisible: (visible: boolean) => void;
  /** Called when the Pay form unmounts: cancels timers and discards late responses. Server-side payment state is untouched, and nothing is cancelled or finalized. */
  detach: () => void;
  reset: () => void;
};

class ApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number,
    /** The body's machine-readable `code`, when it has one. */
    readonly code: string | null = null,
    /** The raw Retry-After header, unparsed — null when absent. Validated only where it is used. */
    readonly retryAfter: string | null = null,
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
  const json = (await response.json()) as T & { error?: string; retryable?: boolean; code?: unknown };
  if (!response.ok) {
    throw new ApiError(
      json.error ?? `Request failed (${response.status}).`,
      json.retryable === true,
      response.status,
      typeof json.code === "string" ? json.code : null,
      response.headers?.get("Retry-After") ?? null,
    );
  }
  return json;
}

/**
 * Reads the lookup answer field by field — never a spread — so nothing beyond
 * handle/displayName/isSelf can enter the store. An answer for any handle
 * other than the one asked about is an error, and a missing isSelf is treated
 * as self (fail closed).
 */
function parseLookupResponse(json: unknown, canonicalHandle: string): RecipientLookup {
  if (typeof json !== "object" || json === null) return { status: "error" };
  const { found, handle, displayName, isSelf } = json as { found?: unknown; handle?: unknown; displayName?: unknown; isSelf?: unknown };
  if (found === false) return { status: "not_found" };
  if (found !== true || handle !== canonicalHandle) return { status: "error" };
  return { status: "found", handle: canonicalHandle, displayName: typeof displayName === "string" ? displayName : null, isSelf: isSelf !== false };
}

const OTHER_PASSKEY_MESSAGE = "This payment was started with a different passkey. Cancel it and start a new payment.";
const CANCEL_LOST_RACE_MESSAGE = "This payment could not be cancelled — it may already be on its way.";
const STATUS_UNUSABLE_MESSAGE = "We couldn’t check on this payment just now. Try again in a little while.";
const STATUS_TIMED_OUT_MESSAGE = "Checking is taking longer than usual. Try again in a little while.";
const CANCEL_UNCONFIRMED_MESSAGE = "Could not confirm whether this payment was cancelled. Check its status before trying again.";

/**
 * Part B: cadence of the follow-up /status check while an expired attempt is
 * still waiting for Base finality (~20 min behind validUntil). Deliberately
 * slow — at most one timer outstanding. 3A-1 Stage 2A: this is now the FIRST
 * interval of a bounded, growing sequence (see followUpDelayMs).
 */
export const EXPIRY_FOLLOW_UP_MS = 75_000;
/** Stage 2A (provisional): automatic follow-up checks per attempt per mounted page lifecycle, after the one initial check. */
export const MAX_AUTOMATIC_FOLLOW_UPS = 8;
/** Stage 2A (provisional): ceiling for any single follow-up interval. */
export const MAX_FOLLOW_UP_INTERVAL_MS = 10 * 60_000;
/** Stage 2A (provisional): how long the manual "Check status" action stays unavailable after a press. */
export const MANUAL_CHECK_COOLDOWN_MS = 30_000;
/** Stage 2C-2: the client's own bound on one /status read. A timeout proves nothing about the server — it only ends OUR wait. */
export const STATUS_REQUEST_DEADLINE_MS = 45_000;
/** Stage 2C-2: the longest delay the chain-read policy can issue (its daily window); anything above is not a delay the server could have meant. */
export const MAX_STATUS_RETRY_AFTER_SECONDS = 86_400;
/** Stage 2C-2: applied when a deferral's delay is missing or unusable — never "retry now". */
export const STATUS_FALLBACK_DEADLINE_MS = 60_000;
/** 3A-2 Stage 2: the longest delay the submit policy can issue (its daily window); anything above is not a delay the server could have meant. */
export const MAX_SUBMIT_RETRY_AFTER_SECONDS = 86_400;
/** 3A-2 Stage 2: applied when a submit denial's Retry-After is missing or unusable — never "retry now". */
export const SUBMIT_FALLBACK_COOLDOWN_MS = 60_000;

/**
 * Reads a Retry-After header as whole seconds, strictly: ASCII digits only (no
 * sign, whitespace, fraction, exponent, leading zero or HTTP-date), from 1
 * through MAX_SUBMIT_RETRY_AFTER_SECONDS. Anything else is null — the caller
 * then uses the local fallback wait, never an immediate retry.
 */
export function parseSubmitRetryAfter(header: string | null | undefined): number | null {
  if (typeof header !== "string" || !/^[1-9][0-9]{0,4}$/.test(header)) return null;
  const seconds = Number(header);
  return seconds <= MAX_SUBMIT_RETRY_AFTER_SECONDS ? seconds : null;
}

/** A submit-budget denial, and nothing else: 429, code exactly "rate_limited", retryable exactly true. Any other 429 is not one. */
function isSubmitBudgetDenial(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 429 && error.code === "rate_limited" && error.retryable === true;
}

/** Stage 2C-2: how many times one caller waits behind an older-epoch read before giving up (each wait is itself bounded by the request deadline). */
const MAX_STALE_READ_WAITS = 2;

/** Interval before follow-up number `index` (0-based): 75 s, then doubling, capped — 75, 150, 300, 600, 600 … seconds. */
export function followUpDelayMs(index: number): number {
  return Math.min(EXPIRY_FOLLOW_UP_MS * 2 ** index, MAX_FOLLOW_UP_INTERVAL_MS);
}

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

type StatusResult = { attempt: RealPaymentAttempt; serverNowSeconds: number; reconciliationDeferred?: unknown; retryAfterSeconds?: unknown };
/** One /status request: which attempt and generation asked, and the freshness epoch it began under. `abort` ends it (timer cleared, request aborted, promise rejected) — idempotent. */
type StatusRead = { attemptId: string; generation: number; epoch: number; promise: Promise<StatusResult>; abort: () => void };

/** Ends OUR wait only. The server may still be working: nothing here is evidence that no provider call happened. */
class StatusTimeoutError extends Error {
  constructor() {
    super(STATUS_TIMED_OUT_MESSAGE);
  }
}

class StatusAbortedError extends Error {}

/**
 * Reads the server's reconciliation verdict from a status answer, field by
 * field. `settled`: an ordinary answer. `deferred`: the server declined to
 * ask a provider and said when to come back (a whole number of seconds in
 * 1…MAX_STATUS_RETRY_AFTER_SECONDS). `malformed`: anything else about those
 * two fields — never treated as permission to retry.
 */
export function interpretStatusResult(result: StatusResult): { kind: "settled" } | { kind: "deferred"; seconds: number } | { kind: "malformed" } {
  const { reconciliationDeferred, retryAfterSeconds } = result;
  if (reconciliationDeferred === undefined || reconciliationDeferred === false) return { kind: "settled" };
  if (reconciliationDeferred !== true) return { kind: "malformed" };
  if (typeof retryAfterSeconds === "number" && Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 1 && retryAfterSeconds <= MAX_STATUS_RETRY_AFTER_SECONDS) {
    return { kind: "deferred", seconds: retryAfterSeconds };
  }
  return { kind: "malformed" };
}

/** Who a retry deadline belongs to: the signed-in account's canonical id, never a display address. */
function currentSubject(): string | null {
  return useRealAccountStore.getState().account?.appUserId ?? null;
}

/** What authorizeAndSubmit needs from its store closure: the lifecycle it runs under, and the submit wait. */
type SubmitHooks = {
  generation: () => number;
  detached: () => boolean;
  /** True (and the wait's flags are published) while a submit wait for this attempt and account is running. */
  isSubmitWaiting: (attemptId: string) => boolean;
  /** Records a valid submit-budget denial for this attempt and account (header unparsed). */
  noteSubmitDenied: (attempt: RealPaymentAttempt, retryAfterHeader: string | null) => void;
};

async function authorizeAndSubmit(
  set: (partial: Partial<RealPaymentStore>) => void,
  get: () => RealPaymentStore,
  scheduleExpiryCheck: () => Promise<void>,
  markTransition: () => void,
  hooks: SubmitHooks,
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
  // The server said to wait: no passkey prompt, no signature, no request —
  // checked on the action itself, not only on the button.
  if (hooks.isSubmitWaiting(attempt.id)) return;

  // The context this call belongs to. After EVERY await below it must still be
  // the current one — the same lifecycle (no reset / account switch / unmount /
  // remount), the same attempt, the same account — or the call ends without
  // touching the store or the network. Dropping an answer is not evidence about
  // the payment: nothing is cancelled, resent or finalized on its account.
  const myGeneration = hooks.generation();
  const subject = account.appUserId;
  const attemptId = attempt.id;
  const isCurrent = () => !hooks.detached() && hooks.generation() === myGeneration && get().attempt?.id === attemptId && currentSubject() === subject;

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
      // A signature for a context that is gone is discarded: never kept, never submitted.
      if (!isCurrent()) return;
      signed = { attemptId: attempt.id, ...result };
    } catch (error) {
      if (!isCurrent()) return;
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
    // A wait that began while the ceremony was open (another denial for this
    // attempt) applies before anything is sent. The fresh approval is kept.
    if (hooks.isSubmitWaiting(attempt.id)) {
      set({ status: "awaiting_authorization", isAuthorizing: false, pendingSubmission: signed, error: null });
      return;
    }
  }

  // Any status read already on its way predates the submit: its answer must not be applied after it.
  markTransition();
  set({ status: "submitting", isAuthorizing: false, pendingSubmission: signed, error: null });
  // Another handler may have changed the payment while this one awaited: only
  // an attempt still waiting for approval, or still being sent, may be moved.
  const stillOpen = () => {
    const shown = get().status;
    return shown === "submitting" || shown === "awaiting_authorization";
  };
  try {
    const result = await api<{ attempt: RealPaymentAttempt }>("/api/real/payments/submit", {
      method: "POST",
      body: JSON.stringify({ attemptId: signed.attemptId, signature: signed.signature, activityId: signed.activityId }),
    });
    // The server did answer, so its answer is the payment's state — but only
    // for the context that asked. (After an unmount the next init() reads it.)
    if (!isCurrent()) return;
    const nextStatus = mapAttemptStateToStatus(result.attempt.state);
    const shown = get().status;
    // Terminal is final: a late answer never moves a confirmed or failed payment to anything else.
    if ((shown === "confirmed" || shown === "failed") && nextStatus !== shown) {
      set({ pendingSubmission: null });
      return;
    }
    markTransition();
    set({ status: nextStatus, attempt: result.attempt, pendingSubmission: null, error: null });
    if (result.attempt.state === "confirmed") void useRealBalanceStore.getState().fetchBalance();
  } catch (error) {
    if (!isCurrent() || !stillOpen()) return;
    if (isSubmitBudgetDenial(error)) {
      // Decided before any provider work: nothing changed, nothing was sent.
      // The same approval stays in memory; the wait is bound to this account
      // and attempt, and the displayed wording comes from it — not from the
      // server's sentence, which says "tap Continue" whatever the wait is.
      hooks.noteSubmitDenied(get().attempt!, error.retryAfter);
      set({ status: "awaiting_authorization", isAuthorizing: false, error: null });
      await scheduleExpiryCheck();
      return;
    }
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
    markTransition();
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
  // Slice C: bumped by every recipient edit, init(), reset(), and a successful
  // cancel. A lookup answer applies only if its sequence AND generation are
  // still current and the input still names the handle it asked about.
  let lookupSequence = 0;
  let inFlightLookup: { handle: string; sequence: number; promise: Promise<void> } | null = null;
  // Stage 2A. The follow-up budget belongs to one attempt within one
  // generation: init()/reset()/detach() clear it, a different attempt id
  // replaces it, and a late callback for the same attempt never restarts it.
  let followUp: { attemptId: string; armed: number; exhausted: boolean } | null = null;
  // False while the Pay page's document is hidden. Nothing automatic starts then.
  let pageVisible = true;
  // True when an automatic check (follow-up/validity timer or the post-submit
  // check) was due while hidden; becoming visible re-evaluates once.
  let followUpSuspended = false;
  let submittedCheckPendingFor: string | null = null;
  // True from detach() (Pay form unmounted) until the next init(): no timer may be armed.
  let detached = false;
  // One outstanding /status request per attempt per generation; every trigger joins it.
  let inFlightStatus: StatusRead | null = null;
  // Freshness barrier. Bumped at every local payment transition (submit
  // started/answered, prepare, a refused cancel). A read that began under an
  // older epoch predates that transition: it is never applied, and a caller
  // that needs current knowledge never joins it.
  let statusEpoch = 0;
  let cooldownTimeoutId: ReturnType<typeof setTimeout> | null = null;
  // Closeout L-1: the absolute end of the manual-check cooldown now in force
  // (0 = none). A later wait is only ever LATER-or-equal: a server delay
  // shorter than the 30 s cooldown never shortens it, and a longer one is
  // never cut to 30 s.
  let manualCooldownUntilMs = 0;
  // Stage 2C-2: the server's "come back after" for ONE attempt of ONE account,
  // as an absolute deadline. Deliberately outside clearFollowUpState: it
  // survives navigation (init/detach) for that same account and attempt — a
  // remount must not become a way around the server's answer — and is dropped
  // by reset(), a different account or attempt, a settled answer, or a 401.
  let statusDeadline: { subject: string | null; attemptId: string; untilMs: number; serverSeconds: number | null } | null = null;
  // Stage 2C-2: after a refused cancel, at most one status read per cooldown
  // window — however fast the user presses Cancel again.
  // ...scoped to the account AND the attempt it was started for: another
  // attempt (or account) never inherits it.
  let cancelRead: { subject: string | null; attemptId: string; untilMs: number } | null = null;
  // Stage 2C.3: the last status read that itself ESTABLISHED "submitted" for an
  // attempt, and the epoch it applied under. The post-submit check exists for a
  // submission this client just made (or restored); a read that already
  // delivered the server's own "submitted" has done that check's job. Any
  // later local transition moves the epoch, which makes the marker stale.
  let submittedByRead: { attemptId: string; epoch: number } | null = null;
  // 3A-2 Stage 2: the server's "come back after" for a refused SUBMIT, for ONE
  // attempt of ONE account, as an absolute deadline. Like statusDeadline it
  // sits outside clearFollowUpState and survives init/detach for that same
  // account and attempt (a remount must not become a way around it), and is
  // dropped by reset(), a successful cancel, a different account or attempt, or
  // its own expiry. Memory only: a hard reload loses it (accepted, as in 3A-1).
  let submitCooldown: { subject: string; attemptId: string; untilMs: number } | null = null;
  let submitCooldownTimerId: ReturnType<typeof setTimeout> | null = null;

  /** Milliseconds left on the retry deadline for this attempt and the signed-in account; 0 when none. A deadline that no longer applies is dropped on sight. */
  function remainingDeadlineMs(attemptId: string): number {
    if (!statusDeadline) return 0;
    const remaining = statusDeadline.untilMs - Date.now();
    if (statusDeadline.attemptId !== attemptId || statusDeadline.subject !== currentSubject() || remaining <= 0) {
      statusDeadline = null;
      return 0;
    }
    return remaining;
  }

  function clearSubmitCooldownTimer() {
    if (submitCooldownTimerId !== null) {
      clearTimeout(submitCooldownTimerId);
      submitCooldownTimerId = null;
    }
  }

  /** Milliseconds left on the submit wait for this attempt and the signed-in account; 0 when none. A wait that no longer applies is dropped on sight. */
  function remainingSubmitCooldownMs(attemptId: string): number {
    if (!submitCooldown) return 0;
    const remaining = submitCooldown.untilMs - Date.now();
    if (submitCooldown.attemptId !== attemptId || submitCooldown.subject !== currentSubject() || remaining <= 0) {
      submitCooldown = null;
      return 0;
    }
    return remaining;
  }

  function clearExpiryTimeout() {
    if (expiryTimeoutId !== null) {
      clearTimeout(expiryTimeoutId);
      expiryTimeoutId = null;
    }
  }

  function clearCooldownTimeout() {
    if (cooldownTimeoutId !== null) {
      clearTimeout(cooldownTimeoutId);
      cooldownTimeoutId = null;
    }
  }

  /** Drops every automatic-follow-up bookkeeping item — used when the lifecycle (generation) ends. */
  function clearFollowUpState() {
    clearExpiryTimeout();
    clearCooldownTimeout();
    // Only the TIMER goes with the lifecycle; the deadline itself (submitCooldown) is re-armed by init() for the same account and attempt.
    clearSubmitCooldownTimer();
    manualCooldownUntilMs = 0;
    followUp = null;
    followUpSuspended = false;
    submittedCheckPendingFor = null;
    // Ends the read's own deadline timer and aborts it: nothing may outlive its lifecycle.
    inFlightStatus?.abort();
    inFlightStatus = null;
    cancelRead = null;
    submittedByRead = null;
  }

  return create<RealPaymentStore>()((set, get) => {
    function isExpiryRelevant(state: Pick<RealPaymentStore, "status" | "attempt">): boolean {
      const validUntil = state.attempt?.prepared?.validUntil;
      return (state.status === "awaiting_authorization" || state.status === "stranded") && typeof validUntil === "number" && Number.isFinite(validUntil);
    }

    function markTransition() {
      statusEpoch++;
    }

    /** True when the server's own "submitted" for this attempt was delivered by a status read under the current epoch (no local transition since). */
    function submittedEstablishedByRead(attemptId: string): boolean {
      return submittedByRead !== null && submittedByRead.attemptId === attemptId && submittedByRead.epoch === statusEpoch;
    }

    /**
     * One bounded /status request. The client waits at most
     * STATUS_REQUEST_DEADLINE_MS: then the request is aborted (where fetch
     * honors it) and — regardless of whether it does — the logical read is
     * rejected, so no slot or waiter can hang on it. A late answer after that
     * is dropped by the settled flag, and every path is handled, so nothing
     * becomes an unhandled rejection. No automatic resend follows a timeout.
     */
    function startRead(attemptId: string): StatusRead {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | null = null;
      let finish: (settle: () => void) => void = () => {};
      let rejectAs: (error: Error) => void = () => {};
      const promise = new Promise<StatusResult>((resolve, reject) => {
        let done = false;
        finish = (settle) => {
          if (done) return;
          done = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          settle();
        };
        rejectAs = (error) =>
          finish(() => {
            controller.abort();
            reject(error);
          });
        timer = setTimeout(() => rejectAs(new StatusTimeoutError()), STATUS_REQUEST_DEADLINE_MS);
        api<StatusResult>(`/api/real/payments/${attemptId}/status`, { signal: controller.signal }).then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
      });
      const entry: StatusRead = { attemptId, generation, epoch: statusEpoch, promise, abort: () => rejectAs(new StatusAbortedError()) };
      const release = () => {
        if (inFlightStatus === entry) inFlightStatus = null;
      };
      promise.then(release, release);
      return entry;
    }

    /**
     * The status read for `attemptId`. Every caller needs knowledge that is
     * current as of NOW, so a read joins only one begun under the CURRENT
     * epoch (ordinary same-epoch callers still share one request). A caller
     * that finds an older-epoch read waits for it to settle — never two
     * concurrent provider-bound requests for one attempt, and each wait is
     * bounded by the request deadline — then re-checks everything (lifecycle,
     * attempt, account, retry deadline) and either joins the current-epoch
     * read another waiter already started or starts one. It gives up after
     * MAX_STALE_READ_WAITS waits — a defensive bound: with a single in-flight
     * slot, a waiter that resumes always finds either nothing or the read
     * another waiter just started under the current epoch, so the bound is
     * not reachable through the public actions; it exists so no future change
     * can turn waiting into an unbounded loop. Returns null — requesting nothing — when the
     * lifecycle ended, or the server's retry deadline for this attempt is
     * still running.
     */
    async function requestStatus(attemptId: string): Promise<StatusRead | null> {
      if (remainingDeadlineMs(attemptId) > 0) return null;
      const myGeneration = generation;
      const subject = currentSubject();
      const stillMine = () => !detached && myGeneration === generation && get().attempt?.id === attemptId && currentSubject() === subject;

      for (let waits = 0; ; waits++) {
        const current = inFlightStatus as StatusRead | null;
        if (!current || current.attemptId !== attemptId || current.generation !== generation) break;
        if (current.epoch === statusEpoch) return current;
        if (waits >= MAX_STALE_READ_WAITS) return null;
        // The older read's own caller discards its answer (its epoch is stale); we only wait for it to finish.
        try {
          await current.promise;
        } catch {
          // A failed, timed-out or aborted older read releases the slot like any other.
        }
        if (!stillMine() || remainingDeadlineMs(attemptId) > 0) return null;
      }
      const entry = startRead(attemptId);
      inFlightStatus = entry;
      return entry;
    }

    /** Records the server's "come back after" for this attempt — or, for an unusable one, a local fallback. Both start the manual cooldown for the same span, so the control and the schedule agree. */
    function noteDeferral(attemptId: string, serverSeconds: number | null) {
      const ms = serverSeconds === null ? STATUS_FALLBACK_DEADLINE_MS : serverSeconds * 1000;
      statusDeadline = { subject: currentSubject(), attemptId, untilMs: Date.now() + ms, serverSeconds };
      set({ isStatusDeferred: true, statusRetryAfterSeconds: serverSeconds });
      beginManualCooldown(ms);
    }

    function clearDeadline() {
      statusDeadline = null;
    }

    /** Resets the follow-up budget when the attempt under watch is a different one. */
    function followUpFor(attemptId: string) {
      if (!followUp || followUp.attemptId !== attemptId) {
        followUp = { attemptId, armed: 0, exhausted: false };
        if (get().isFollowUpExhausted) set({ isFollowUpExhausted: false });
      }
      return followUp;
    }

    /**
     * Starts (or restarts) the manual-check cooldown. Stage 2B can pass a
     * longer server-supplied Retry-After here; nothing else about the manual
     * check needs to change for that.
     */
    function beginManualCooldown(ms: number = MANUAL_CHECK_COOLDOWN_MS) {
      // The LATER of what is already running and what is being asked for.
      const now = Date.now();
      const until = Math.max(now + Math.max(0, ms), manualCooldownUntilMs > now ? manualCooldownUntilMs : 0);
      manualCooldownUntilMs = until;
      clearCooldownTimeout();
      set({ isManualCheckCoolingDown: true });
      const myGeneration = generation;
      cooldownTimeoutId = setTimeout(
        () => {
          cooldownTimeoutId = null;
          manualCooldownUntilMs = 0;
          if (myGeneration === generation) set({ isManualCheckCoolingDown: false, isStatusDeferred: false });
        },
        Math.min(Math.max(0, until - now), 2_147_483_647),
      );
    }

    function endManualCooldown() {
      clearCooldownTimeout();
      manualCooldownUntilMs = 0;
      if (get().isManualCheckCoolingDown) set({ isManualCheckCoolingDown: false });
    }

    /** Arms the single outstanding timer — unless the page is hidden or detached, in which case it is only remembered (suspended) and re-evaluated when the page is visible again. */
    function armExpiryTimer(delayMs: number) {
      clearExpiryTimeout();
      if (detached) return;
      if (!pageVisible) {
        followUpSuspended = true;
        return;
      }
      const attemptId = get().attempt?.id;
      const myGeneration = generation;
      expiryTimeoutId = setTimeout(
        () => {
          expiryTimeoutId = null;
          const current = get();
          if (detached || myGeneration !== generation || current.attempt?.id !== attemptId || !isExpiryRelevant(current)) return;
          if (!pageVisible) {
            followUpSuspended = true;
            return;
          }
          void runExpiryCheck();
        },
        // Clamped: a delay above 2^31-1 ms would overflow and fire immediately.
        Math.min(Math.max(0, delayMs), 2_147_483_647),
      );
    }

    /**
     * Arms the next follow-up for the attempt under watch, or — once
     * MAX_AUTOMATIC_FOLLOW_UPS timers have been armed — stops the automatic
     * sequence. Exhaustion changes no payment state; the manual check remains.
     */
    function armNextFollowUp(attemptId: string) {
      const budget = followUpFor(attemptId);
      if (budget.armed >= MAX_AUTOMATIC_FOLLOW_UPS) {
        budget.exhausted = true;
        clearExpiryTimeout();
        if (!get().isFollowUpExhausted) set({ isFollowUpExhausted: true });
        return;
      }
      // The later of the exponential schedule and the server's retry deadline.
      armExpiryTimer(Math.max(followUpDelayMs(budget.armed++), remainingDeadlineMs(attemptId)));
    }

    /**
     * The one status read every trigger shares (automatic follow-up, manual
     * Check status, post-submit check). The response is applied only to the
     * attempt and generation it was asked for. It is a read: nothing here
     * submits, resends, cancels or finalizes anything.
     */
    async function performStatusCheck(): Promise<void> {
      const attempt = get().attempt;
      if (!attempt || detached) return;
      // S2: captured before the await, verified after it — a response for
      // a previous generation (reset / account switch / unmount), a previous
      // attempt, or another signed-in account is discarded entirely, never
      // applied over the current one.
      const myGeneration = generation;
      const subject = currentSubject();
      const isCurrent = () => myGeneration === generation && get().attempt?.id === attempt.id && currentSubject() === subject;
      let read: StatusRead | null = null;
      try {
        read = await requestStatus(attempt.id);
        if (!read) return;
        const result = await read.promise;
        // A read that began before a local transition (submit, refused cancel) describes the payment as it WAS.
        if (!isCurrent() || result.attempt.id !== attempt.id || read.epoch !== statusEpoch) return;
        const verdict = interpretStatusResult(result);
        if (verdict.kind === "malformed") {
          // The attempt in this answer is not trusted either: keep the last reliable one, back off, say so plainly.
          noteDeferral(attempt.id, null);
          set({ error: STATUS_UNUSABLE_MESSAGE });
          return;
        }
        const nextStatus = mapAttemptStateToStatus(result.attempt.state);
        // Terminal is final: no answer may move a confirmed or failed payment to anything else.
        const shown = get().status;
        if ((shown === "confirmed" || shown === "failed") && nextStatus !== shown) return;
        const offset = computeClockOffsetSeconds(result.serverNowSeconds);
        set({
          status: nextStatus,
          attempt: result.attempt,
          clockOffsetSeconds: offset,
          // Recomputed here too (not only in scheduleOrRunExpiryCheck) so a
          // standalone check (the manual "Check status" button, the
          // post-submit one-shot check) never leaves a stale
          // isAttemptPastValidity from before this response.
          isAttemptPastValidity: isAttemptPastValidityNow(result.attempt, nextStatus, offset),
          error: null,
          ...(verdict.kind === "settled" ? { isStatusDeferred: false, statusRetryAfterSeconds: null } : {}),
        });
        if (verdict.kind === "deferred") noteDeferral(attempt.id, verdict.seconds);
        else clearDeadline();
        if (nextStatus === "submitted") submittedByRead = { attemptId: attempt.id, epoch: read.epoch };
        // A terminal (or otherwise no-longer-expiring) answer ends the follow-up schedule now.
        if (!isExpiryRelevant(get())) clearExpiryTimeout();
        // The stored attempt is authoritative even in a deferred answer: if it says confirmed, the balance moved.
        if (result.attempt.state === "confirmed") void useRealBalanceStore.getState().fetchBalance();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          if (isCurrent()) clearDeadline();
        }
        // A failure of a read that predates a transition says nothing about the payment as it is now.
        if (isCurrent() && (!read || read.epoch === statusEpoch)) {
          set({ error: error instanceof StatusTimeoutError ? STATUS_TIMED_OUT_MESSAGE : error instanceof Error ? error.message : "Could not check payment status." });
        }
      }
    }

    /**
     * One automatic /status reconciliation for an attempt believed past
     * validUntil. Base finality usually lags validUntil by ~20 min, so the
     * first answer is normally the same non-terminal attempt; in that case the
     * next follow-up is armed, at a growing interval, up to the bound. Stops as
     * soon as the attempt is terminal/non-expiry-relevant, a different attempt,
     * a different generation, or the page is detached.
     */
    async function runExpiryCheck(): Promise<void> {
      const attemptId = get().attempt?.id;
      const myGeneration = generation;
      {
        // The validity timer exists to fire exactly when validUntil passes, but
        // the flag was last computed before that. A failing read would never
        // refresh it, leaving "waiting for your approval" on an expired payment.
        const { attempt, status, clockOffsetSeconds, isAttemptPastValidity } = get();
        const pastNow = isAttemptPastValidityNow(attempt, status, clockOffsetSeconds);
        if (pastNow !== isAttemptPastValidity) set({ isAttemptPastValidity: pastNow });
      }
      await performStatusCheck();
      const current = get();
      if (detached || myGeneration !== generation || !attemptId || current.attempt?.id !== attemptId || !isExpiryRelevant(current)) return;
      armNextFollowUp(attemptId);
    }

    /**
     * Part B (S2): if the current awaiting_authorization/stranded attempt is
     * already past validUntil, reconcile now (and follow up slowly, boundedly,
     * while it stays non-terminal); otherwise arm one timer for the instant
     * validUntil passes. Never a rapid poll. Returns a promise so init() can
     * await the immediate case — its first render then reflects the reconciled
     * state. `justChecked`: the caller has just applied a fresh /status answer,
     * so only the follow-up is armed — no second request right behind it.
     */
    function scheduleOrRunExpiryCheck(options: { justChecked?: boolean } = {}): Promise<void> {
      clearExpiryTimeout();
      const { attempt, status, clockOffsetSeconds } = get();
      // Computed here (plain store logic), never read from Date.now() inside
      // the component's render — see isAttemptPastValidity's doc comment.
      const pastValidity = isAttemptPastValidityNow(attempt, status, clockOffsetSeconds);
      set({ isAttemptPastValidity: pastValidity });
      if (!isExpiryRelevant({ attempt, status })) return Promise.resolve();
      const budget = followUpFor(attempt!.id);
      // Exhausted: no automatic request of any kind until a manual check or a fresh lifecycle.
      if (detached || budget.exhausted) return Promise.resolve();
      if (!pageVisible) {
        followUpSuspended = true;
        return Promise.resolve();
      }
      if (pastValidity) {
        if (options.justChecked) {
          armNextFollowUp(attempt!.id);
          return Promise.resolve();
        }
        return runExpiryCheck();
      }
      const adjustedNowSeconds = Math.floor(Date.now() / 1000) + clockOffsetSeconds;
      // +1 s: the server treats an attempt as expired only strictly after validUntil.
      armExpiryTimer((attempt!.prepared!.validUntil - adjustedNowSeconds + 1) * 1000);
      return Promise.resolve();
    }

    /**
     * Publishes the submit wait for the CURRENT attempt to the store and arms
     * the one timer that ends it. The timer only flips the flag: it never
     * signs, submits, resends or checks anything — a valid user action is
     * required afterwards.
     */
    function publishSubmitCooldown(attempt: RealPaymentAttempt) {
      const remaining = remainingSubmitCooldownMs(attempt.id);
      if (remaining <= 0 || !submitCooldown) return;
      const untilMs = submitCooldown.untilMs;
      // Would the wait end too late for this approval to still be dispatched? Same margin the server applies.
      const validUntil = attempt.prepared?.validUntil;
      const retryAtSeconds = Math.ceil(untilMs / 1000) + get().clockOffsetSeconds;
      const beyondApproval = !hasEnoughValidityToDispatch(typeof validUntil === "number" ? validUntil : null, retryAtSeconds);
      set({ isSubmitCoolingDown: true, submitCooldownSeconds: Math.ceil(remaining / 1000), isSubmitRetryBeyondApproval: beyondApproval });
      clearSubmitCooldownTimer();
      const myGeneration = generation;
      const attemptId = attempt.id;
      submitCooldownTimerId = setTimeout(
        () => {
          submitCooldownTimerId = null;
          if (detached || myGeneration !== generation || get().attempt?.id !== attemptId) return;
          // A delay above the timer ceiling fires early: wait out the rest.
          const current = get().attempt;
          if (current && remainingSubmitCooldownMs(attemptId) > 0) {
            publishSubmitCooldown(current);
            return;
          }
          set({ isSubmitCoolingDown: false });
        },
        Math.min(Math.max(0, remaining), 2_147_483_647),
      );
    }

    /** A valid submit-budget denial: the later of any running wait and the server's delay (or the local fallback for unusable metadata). */
    function noteSubmitDenied(attempt: RealPaymentAttempt, retryAfterHeader: string | null) {
      const subject = currentSubject();
      if (subject === null) return;
      const seconds = parseSubmitRetryAfter(retryAfterHeader);
      const ms = seconds === null ? SUBMIT_FALLBACK_COOLDOWN_MS : seconds * 1000;
      const now = Date.now();
      const running = remainingSubmitCooldownMs(attempt.id) > 0 && submitCooldown ? submitCooldown.untilMs : 0;
      submitCooldown = { subject, attemptId: attempt.id, untilMs: Math.max(now + ms, running) };
      publishSubmitCooldown(attempt);
    }

    /** True while a wait for this attempt and account is running; also re-publishes its flags, so a remount or a handler that raced a denial agrees with the record. */
    function isSubmitWaiting(attemptId: string): boolean {
      if (remainingSubmitCooldownMs(attemptId) <= 0) return false;
      const attempt = get().attempt;
      if (attempt?.id === attemptId) publishSubmitCooldown(attempt);
      return true;
    }

    const submitHooks: SubmitHooks = {
      generation: () => generation,
      detached: () => detached,
      isSubmitWaiting,
      noteSubmitDenied,
    };

    function currentRecipientView(): RecipientView {
      return resolveRecipientView(get().recipientInput, get().recipientLookup, useRealAccountStore.getState().account?.handle ?? null);
    }

    /** One exact lookup of an already-canonical handle. A second caller for the same still-current lookup joins it instead of sending another request. */
    function lookupHandle(canonicalHandle: string): Promise<void> {
      if (inFlightLookup && inFlightLookup.handle === canonicalHandle && inFlightLookup.sequence === lookupSequence) return inFlightLookup.promise;
      const mySequence = ++lookupSequence;
      const myGeneration = generation;
      set({ recipientLookup: { status: "looking_up" } });
      const promise = (async () => {
        let next: RecipientLookup;
        try {
          const response = await fetch("/api/real/recipients/lookup", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ handle: canonicalHandle }),
          });
          // Slice E: 429 is this account's name-check budget, shown as its own
          // message. Nothing retries it automatically — leaving the field does
          // not ask again; only pressing Review does, once per press.
          next = response.status === 429 ? { status: "rate_limited" } : response.ok ? parseLookupResponse(await response.json(), canonicalHandle) : { status: "error" };
        } catch {
          next = { status: "error" };
        }
        if (inFlightLookup?.sequence === mySequence) inFlightLookup = null;
        if (mySequence !== lookupSequence || myGeneration !== generation) return;
        const view = currentRecipientView();
        if (view.kind !== "checking" || view.handle !== canonicalHandle) return;
        set({ recipientLookup: next });
      })();
      inFlightLookup = { handle: canonicalHandle, sequence: mySequence, promise };
      return promise;
    }

    /**
     * The synchronous part of review(): validates, and opens the review
     * screen for an address or a found @name. Returns the handle that still
     * needs a lookup before review can open, otherwise null.
     */
    function reviewNow(): string | null {
      const view = currentRecipientView();
      if (view.kind === "empty") {
        set({ error: "Enter who you're paying." });
        return null;
      }
      if (view.kind === "invalid") {
        set({ error: view.message });
        return null;
      }
      if (view.kind === "self") {
        set({ error: ownHandleMessage(view.handle) });
        return null;
      }
      if (view.kind === "not_found") return null;

      const amountBaseUnits = parseCashInputToBaseUnits(get().amountInput);
      if (!amountBaseUnits || isZeroBaseUnits(amountBaseUnits)) {
        set({ error: "Enter an amount greater than zero." });
        return null;
      }
      if (exceedsPaymentCeiling(amountBaseUnits)) {
        set({ error: `Payments are limited to ${formatCashBaseUnits(MAX_PAYMENT_BASE_UNITS, REAL_CASH_TOKEN.decimals)} each for now.` });
        return null;
      }
      const balance = useRealBalanceStore.getState().balance;
      if (balance && exceedsAvailableBalance(amountBaseUnits, balance.balanceBaseUnits)) {
        set({ error: "That's more than your available Cash." });
        return null;
      }
      if (view.kind === "address" || view.kind === "found") {
        set({ status: "reviewing", error: null });
        return null;
      }
      return view.handle; // unresolved, checking, lookup_failed, or lookup_rate_limited: one lookup per Review press
    }

    return {
      status: "idle",
      recipientInput: "",
      recipientLookup: { status: "idle" },
      amountInput: "",
      attempt: null,
      subOrganizationId: null,
      authorizingCredentialId: null,
      pendingSubmission: null,
      isAuthorizing: false,
      isManualCheckCoolingDown: false,
      isFollowUpExhausted: false,
      isStatusDeferred: false,
      statusRetryAfterSeconds: null,
      isSubmitCoolingDown: false,
      submitCooldownSeconds: null,
      isSubmitRetryBeyondApproval: false,
      clockOffsetSeconds: 0,
      isAttemptPastValidity: false,
      error: null,

      init: async () => {
        const myGeneration = ++generation;
        lookupSequence++;
        clearFollowUpState();
        detached = false;
        // Pre-2f hardening: clear any prior account's recipient/amount/
        // attempt/error as the FIRST synchronous action, before the fetch —
        // so "reset before init" holds regardless of which caller invokes
        // this (see components/real/real-pay-form.tsx's account-change
        // effect). Without this, a stale recipient/amount typed under one
        // account could survive into a different signed-in account.
        set({ status: "idle", recipientInput: "", recipientLookup: { status: "idle" }, amountInput: "", attempt: null, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false, isManualCheckCoolingDown: false, isFollowUpExhausted: false, isStatusDeferred: false, statusRetryAfterSeconds: null, isSubmitCoolingDown: false, submitCooldownSeconds: null, isSubmitRetryBeyondApproval: false, clockOffsetSeconds: 0, isAttemptPastValidity: false, error: null });
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
            // A retry deadline the server gave for THIS attempt and account still applies after a remount.
            const waiting = remainingDeadlineMs(json.attempt.id);
            if (waiting > 0) {
              set({ isStatusDeferred: true, statusRetryAfterSeconds: statusDeadline?.serverSeconds ?? null });
              beginManualCooldown(waiting);
            }
            // Same account, same attempt: the submit wait the server gave still applies. A different attempt or account finds none.
            if (json.attempt.state === "awaiting_authorization") publishSubmitCooldown(json.attempt);
            await scheduleOrRunExpiryCheck();
          }
        } catch {
          if (myGeneration === generation) set({ status: "editing" });
        }
      },

      setRecipientInput: (value) => {
        // Any edit drops the previous answer and any answer still on its way.
        lookupSequence++;
        set({ recipientInput: value, recipientLookup: { status: "idle" }, error: null });
      },
      setAmountInput: (value) => set({ amountInput: value, error: null }),

      lookupRecipient: async () => {
        if (get().status !== "editing") return;
        const view = currentRecipientView();
        if (view.kind === "unresolved" || view.kind === "lookup_failed") await lookupHandle(view.handle);
      },

      review: () => {
        const handle = reviewNow();
        if (handle === null) return Promise.resolve();
        // Handle path only: look the name up (or join the lookup the field's
        // blur already started), then open review only if nothing changed
        // underneath it and the name was found.
        const myGeneration = generation;
        const amountInput = get().amountInput;
        return lookupHandle(handle).then(() => {
          if (myGeneration !== generation || get().status !== "editing" || get().amountInput !== amountInput) return;
          const view = currentRecipientView();
          if (view.kind === "found" && view.handle === handle) reviewNow();
        });
      },

      editAgain: () => set({ status: "editing", error: null }),

      confirmAndSend: async () => {
        if (get().status !== "reviewing") return; // guards a double-tap from re-firing prepare
        const view = currentRecipientView();
        const amountBaseUnits = parseCashInputToBaseUnits(get().amountInput);
        // Fails closed: a handle payment goes out only from `found` — the
        // lookup's handle is the current input's handle and isn't the payer.
        if ((view.kind !== "address" && view.kind !== "found") || !amountBaseUnits) {
          set({ status: "editing", error: "Enter a valid recipient and amount." });
          return;
        }
        // Exactly one selector. A handle payment names ONLY the canonical
        // handle: the server derives the destination, and the lookup result
        // is never sent as (or treated as) the payment's authority.
        const body = view.kind === "address" ? { recipient: view.recipient, amountBaseUnits } : { recipientHandle: view.handle, amountBaseUnits };

        set({ status: "preparing", error: null });
        // A prepare answer applies only to the lifecycle and account that asked,
        // and nothing may be signed for a context that has since been replaced.
        const myGeneration = generation;
        const preparedFor = currentSubject();
        try {
          const result = await api<{ attempt: RealPaymentAttempt; subOrganizationId: string; authorizingCredentialId: string; serverNowSeconds: number }>("/api/real/payments/prepare", {
            method: "POST",
            body: JSON.stringify(body),
          });
          if (detached || myGeneration !== generation || currentSubject() !== preparedFor) return;
          submitCooldown = null;
          clearSubmitCooldownTimer();
          set({
            status: "awaiting_authorization",
            attempt: result.attempt,
            subOrganizationId: result.subOrganizationId,
            authorizingCredentialId: result.authorizingCredentialId,
            pendingSubmission: null,
            // The previous attempt's wait (if any) was dropped above; what the screen published for it goes too.
            isSubmitCoolingDown: false,
            submitCooldownSeconds: null,
            isSubmitRetryBeyondApproval: false,
            clockOffsetSeconds: computeClockOffsetSeconds(result.serverNowSeconds),
            error: null,
          });
          markTransition();
          endManualCooldown();
          await scheduleOrRunExpiryCheck();
        } catch (error) {
          if (detached || myGeneration !== generation || currentSubject() !== preparedFor) return;
          // The server no longer finds the name (404) or refused the request
          // itself (400, e.g. paying yourself): the earlier lookup answer is
          // stale, so drop it. The typed text stays for the user to fix.
          const staleRecipient = view.kind === "found" && error instanceof ApiError && (error.status === 404 || error.status === 400);
          if (staleRecipient) lookupSequence++;
          set({
            status: "editing",
            error: error instanceof Error ? error.message : "Could not prepare the payment.",
            ...(staleRecipient ? { recipientLookup: { status: "idle" } as const } : {}),
          });
          return;
        }

        // scheduleOrRunExpiryCheck above awaited: the context may have moved on.
        if (detached || myGeneration !== generation || currentSubject() !== preparedFor) return;
        await authorizeAndSubmit(set, get, scheduleOrRunExpiryCheck, markTransition, submitHooks);
      },

      resumeAuthorization: async () => {
        // One approval at a time: a second press while the passkey sheet is open does nothing.
        if (get().status !== "awaiting_authorization" || get().isAuthorizing) return;
        await authorizeAndSubmit(set, get, scheduleOrRunExpiryCheck, markTransition, submitHooks);
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
          endManualCooldown();
          clearDeadline();
          submitCooldown = null;
          clearSubmitCooldownTimer();
          cancelRead = null;
          followUp = null;
          submittedCheckPendingFor = null;
          lookupSequence++;
          set({
            status: "editing",
            attempt: null,
            recipientLookup: { status: "idle" },
            subOrganizationId: null,
            authorizingCredentialId: null,
            pendingSubmission: null,
            isAuthorizing: false,
            recipientInput: "",
            amountInput: "",
            isAttemptPastValidity: false,
            isFollowUpExhausted: false,
            isStatusDeferred: false,
            statusRetryAfterSeconds: null,
            isSubmitCoolingDown: false,
            submitCooldownSeconds: null,
            isSubmitRetryBeyondApproval: false,
            error: null,
          });
          return;
        }

        // Part D: a non-2xx (e.g. 409 — a concurrent submit already won the
        // race) means cancellation did NOT happen. Never show a false
        // "cancelled" state — re-fetch the real durable state instead.
        // The refusal itself is news: a read that began before it may predate
        // whatever won the race, so any such read is now stale — EXCEPT inside
        // this attempt's own read window: the read begun for the first refusal
        // is exactly the useful one, and invalidating it for a repeat press
        // would lose its answer with no replacement allowed (closeout L-2).
        // Genuine state transitions (submit, prepare) still bump the epoch.
        const sameWindow = cancelRead !== null && cancelRead.attemptId === attempt.id && cancelRead.subject === currentSubject() && Date.now() < cancelRead.untilMs;
        if (!sameWindow) markTransition();
        // ...and only ONE reconciliation read per cooldown window, however fast
        // Cancel is pressed again, and never inside the server's retry deadline.
        // The refusal is still reported; the payment is left exactly as it is.
        if (sameWindow || remainingDeadlineMs(attempt.id) > 0) {
          set({ error: CANCEL_LOST_RACE_MESSAGE });
          return;
        }
        cancelRead = { subject: currentSubject(), attemptId: attempt.id, untilMs: Date.now() + MANUAL_CHECK_COOLDOWN_MS };
        try {
          const read = await requestStatus(attempt.id);
          if (!read) {
            if (isCurrent()) set({ error: CANCEL_LOST_RACE_MESSAGE });
            return;
          }
          const result = await read.promise;
          if (!isCurrent() || result.attempt.id !== attempt.id || read.epoch !== statusEpoch) return;
          const verdict = interpretStatusResult(result);
          if (verdict.kind === "malformed") {
            noteDeferral(attempt.id, null);
            set({ error: CANCEL_UNCONFIRMED_MESSAGE });
            return;
          }
          const shown = get().status;
          const nextStatus = mapAttemptStateToStatus(result.attempt.state);
          if ((shown === "confirmed" || shown === "failed") && nextStatus !== shown) return;
          set({
            status: nextStatus,
            attempt: result.attempt,
            clockOffsetSeconds: computeClockOffsetSeconds(result.serverNowSeconds),
            error: CANCEL_LOST_RACE_MESSAGE,
            ...(verdict.kind === "settled" ? { isStatusDeferred: false, statusRetryAfterSeconds: null } : {}),
          });
          if (verdict.kind === "deferred") noteDeferral(attempt.id, verdict.seconds);
          else clearDeadline();
          if (nextStatus === "submitted") submittedByRead = { attemptId: attempt.id, epoch: read.epoch };
          // This answer is fresh: only the follow-up is armed, not a second request behind it.
          await scheduleOrRunExpiryCheck({ justChecked: true });
        } catch {
          // Couldn't confirm the real state either — preserve what we had
          // rather than guessing in either direction.
          if (isCurrent()) set({ error: CANCEL_UNCONFIRMED_MESSAGE });
        }
      },

      checkStatus: async () => {
        const attempt = get().attempt;
        if (!attempt || get().isManualCheckCoolingDown) return;
        // The server said when to come back: the control stays unavailable until then, and nothing is sent.
        const waiting = remainingDeadlineMs(attempt.id);
        if (waiting > 0) {
          set({ isStatusDeferred: true, statusRetryAfterSeconds: statusDeadline?.serverSeconds ?? null });
          beginManualCooldown(waiting);
          return;
        }
        beginManualCooldown();
        await performStatusCheck();
      },

      checkSubmittedStatus: async () => {
        const { attempt, status } = get();
        if (!attempt || status !== "submitted" || detached) return;
        // A status read that itself delivered "submitted" already did this check's job.
        if (submittedEstablishedByRead(attempt.id)) return;
        if (!pageVisible) {
          submittedCheckPendingFor = attempt.id;
          return;
        }
        submittedCheckPendingFor = null;
        // Follows the submit: it must see the server's state AFTER it, never an older read that was already on its way.
        await performStatusCheck();
      },

      setPageVisible: (visible) => {
        const wasVisible = pageVisible;
        pageVisible = visible;
        if (!visible) {
          // Suspend, don't lose: a timer that was outstanding is remembered and re-evaluated on return.
          if (expiryTimeoutId !== null) {
            clearExpiryTimeout();
            followUpSuspended = true;
          }
          return;
        }
        if (wasVisible || detached) return;
        // Back in view: re-evaluate once. Never a catch-up burst — at most one
        // check, and an exhausted sequence stays exhausted.
        const resumeFollowUp = followUpSuspended;
        followUpSuspended = false;
        const submittedPending = submittedCheckPendingFor !== null && submittedCheckPendingFor === get().attempt?.id;
        submittedCheckPendingFor = null;
        if (resumeFollowUp) void scheduleOrRunExpiryCheck();
        if (submittedPending && get().status === "submitted" && !submittedEstablishedByRead(get().attempt!.id)) void performStatusCheck();
      },

      detach: () => {
        // The Pay form is gone: no timer may outlive it and no in-flight answer
        // may apply (or arm anything) afterwards. Server state is untouched.
        detached = true;
        generation++;
        lookupSequence++;
        clearFollowUpState();
        // The submit wait's deadline is kept for the same account and attempt; only what the screen showed goes.
        set({ isManualCheckCoolingDown: false, isStatusDeferred: false, isSubmitCoolingDown: false });
      },

      reset: () => {
        generation++;
        lookupSequence++;
        clearFollowUpState();
        // A new compose flow / sign-out: the previous attempt's deadline has nothing left to govern.
        clearDeadline();
        submitCooldown = null;
        set({ isManualCheckCoolingDown: false, isFollowUpExhausted: false, isStatusDeferred: false, statusRetryAfterSeconds: null, isSubmitCoolingDown: false, submitCooldownSeconds: null, isSubmitRetryBeyondApproval: false, status: "editing", recipientLookup: { status: "idle" }, attempt: null, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false, recipientInput: "", amountInput: "", error: null });
      },
    };
  });
}

export const useRealPaymentStore = createRealPaymentStore();
