import { create } from "zustand";
import { exceedsAvailableBalance, exceedsPaymentCeiling, isZeroBaseUnits, MAX_PAYMENT_BASE_UNITS, parseCashInputToBaseUnits } from "@/lib/real/payments/amount";
import { formatCashBaseUnits } from "@/lib/real/display/cash";
import { REAL_CASH_TOKEN } from "@/lib/real/constants";
import { signPreparedPayment } from "@/lib/real/payments/client-sign";
import { hasEnoughValidityToDispatch } from "@/lib/real/payments/validity";
import { isWebAuthnCancellation } from "@/lib/real/signing/passkey";
import type { WirePreparedFields } from "@/lib/real/payments/prepared-operation";
import { ownHandleMessage, resolveRecipientView, type RecipientLookup, type RecipientView } from "@/lib/real/recipient-input";
import { readRecipientIdentity, type PaymentRecipientIdentity } from "@/lib/real/display/payment-recipient";
import { isValidUuid } from "@/lib/real/identifiers";
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
   * prepared before binding existed). L-2 D-4: also entered when /submit
   * itself answers the exact `wrong_passkey` refusal (HTTP 409 + that code).
   */
  | "stranded"
  /**
   * L-2 D-3a: the initial read of the latest payment (init's GET /latest) did
   * not give a trustworthy answer — a non-2xx other than 401, a network
   * failure, an unreadable or malformed reply, or the client's own wait ran
   * out. It says ONLY that this page could not tell what the latest payment
   * is: not that none exists, and not that one failed, was cancelled, expired
   * or completed. `attempt` stays null, nothing may be prepared, and the one
   * way forward is the explicit checkPaymentsAgain() (or a new lifecycle).
   */
  | "status_unavailable";

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
  /**
   * L-2 D-1: set when a prepare request ended without a trustworthy answer
   * (HTTP 500 including the server's `prepare_outcome_uncertain`, HTTP 409 —
   * except, since L-2 D-2, the exact `account_not_ready` refusal — a network
   * failure or an unreadable reply). A payment MAY exist on the server
   * even though this page never saw it — and an existing one holds the account's
   * only active-payment slot. While set, Review is not offered and review() /
   * confirmAndSend() refuse: the one way out is a successful, current
   * checkPreparedPayment() (or a new lifecycle). Editing the form never clears
   * it. Memory only; never persisted; dropped by init/reset/detach.
   */
  prepareNeedsCheck: null | "uncertain" | "in_progress";
  /**
   * L-2 D-8: why the last submit or status read of THIS payment ended in an HTTP
   * 401 ("signed_out") or an HTTP 404 ("not_accessible") — exact status only.
   * It only picks fixed wording and whether the unknown screen offers the
   * explicit session check; it says nothing about the payment, which may well
   * have been sent. Memory only; never persisted; dropped by init/reset/detach,
   * a successful Cancel, a new submit and any answered status read.
   */
  sessionRecovery: null | "signed_out" | "not_accessible";
  /** L-2 D-1: where the explicit status check stands. "nothing_found" is the confirmation that no active payment exists (shown once; cleared by the next Review). "unavailable" means the check itself failed — it proves nothing about any payment. */
  prepareCheck: "idle" | "checking" | "unavailable" | "nothing_found";
  /** L-2 D-1: true while this page's one Cancel request is on its way. A second press is ignored; nothing is retried or released locally. */
  isCancelling: boolean;
  /**
   * Reload/restore: never signs, never submits, never resends — see server/payments.ts's resolveLatestPayment.
   * L-2 D-3a: one GET /latest, waited on for at most STATUS_REQUEST_DEADLINE_MS;
   * anything but a trustworthy answer (or a 401) ends in "status_unavailable",
   * never in the ordinary form. Always resolves; never retries by itself.
   */
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
  /**
   * L-2 D-1: the explicit "Check payment status" action after an unresolved
   * prepare. Exactly one GET /api/real/payments/latest per call; never signs,
   * submits, prepares or cancels. Adopts a NON-terminal attempt (the server's
   * record is the truth, not the form); a missing or terminal attempt only
   * releases the recovery requirement; a failed check keeps it.
   */
  checkPreparedPayment: () => Promise<void>;
  /**
   * L-2 D-3a: the explicit "Check again" action after the initial read failed
   * ("status_unavailable"). It re-runs init() — one GET /latest — and nothing
   * else: no mutation, no provider work, no automatic repeat. A no-op in any
   * other status, so a second press while the retry is loading does nothing.
   */
  checkPaymentsAgain: () => Promise<void>;
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

/** L-2 D-1: fixed client copy. Raw "Failed to fetch" / parse errors and the server's own text are never shown for an unresolved prepare. */
export const PREPARE_UNCERTAIN_MESSAGE = "We couldn't confirm whether your payment was set up. Check its status before trying again.";
export const PREPARE_IN_PROGRESS_MESSAGE = "A payment may already be in progress. Check its status before trying again.";
export const PREPARE_CHECK_FAILED_MESSAGE = "We couldn't check right now. Try again in a moment.";
export const PREPARE_CHECK_NONE_MESSAGE = "No payment is waiting. You can review your payment again.";

/** L-2 D-3a: fixed client copy for a failed initial payment check. No network, parse or server text is ever shown with it. */
export const PAYMENTS_UNAVAILABLE_HEADLINE = "We couldn't check your payments right now.";
export const PAYMENTS_UNAVAILABLE_DETAIL = "Check again before starting a new payment.";

/**
 * L-2 D-1: does a failed prepare leave the payment's existence unknown?
 * 500 (incl. `prepare_outcome_uncertain`) and a non-ApiError (network failure,
 * unreadable reply) are "uncertain"; 409 is "in_progress". Everything else —
 * 400/401/404/429, the known `prepare_failed` 502 — keeps its own handling.
 * (L-2 D-2: the caller takes the exact `account_not_ready` 409 out first — see
 * isAccountNotReadyRefusal below.)
 */
function classifyPrepareFailure(error: unknown): "uncertain" | "in_progress" | null {
  if (!(error instanceof ApiError)) return "uncertain";
  if (error.status === 500) return "uncertain";
  if (error.status === 409) return "in_progress";
  return null;
}

/** L-2 D-2: fixed client copy for the one definitive prepare 409. The server's own sentence is never shown. */
export const PREPARE_ACCOUNT_NOT_READY_MESSAGE = "We can't send payments from this account right now. This payment wasn't started.";

/**
 * L-2 D-2: the ONE prepare 409 that is a definitive refusal rather than "a
 * payment may exist" — HTTP 409 AND the body's `code` exactly
 * "account_not_ready" (the server decides it before any charge, provider call
 * or row). Exact status and exact string only: no sentence matching, no case
 * folding, no trimming. Every other 409 (no code, another code, a non-string
 * code) stays "in_progress" in classifyPrepareFailure above, which is
 * deliberately left unaware of this exception — if this check is ever removed
 * the answer falls back to D-1's status check, never to a plain form.
 */
function isAccountNotReadyRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "account_not_ready";
}

const KNOWN_ATTEMPT_STATES: ReadonlySet<string> = new Set<RealPaymentAttemptState>(["prepared", "awaiting_authorization", "signed", "submitting", "submitted", "confirmed", "failed", "cancelled", "unknown"]);
const TERMINAL_ATTEMPT_STATES: ReadonlySet<string> = new Set<RealPaymentAttemptState>(["confirmed", "failed", "cancelled"]);

type LatestPayload = {
  attempt: RealPaymentAttempt | null;
  subOrganizationId?: string | null;
  authorizingCredentialId?: string | null;
  serverNowSeconds?: number;
  error?: string;
};

/**
 * L-2 D-1: reads a /latest answer for the explicit check, fail-closed. Only an
 * explicit `attempt: null` is "none" — a missing attempt, a non-object, an
 * unknown state or a missing id is "unusable", never "no payment exists".
 */
function readLatestForCheck(json: unknown): { kind: "none" } | { kind: "terminal" } | { kind: "active"; payload: LatestPayload; attempt: RealPaymentAttempt } | { kind: "unusable" } {
  if (typeof json !== "object" || json === null || !("attempt" in json)) return { kind: "unusable" };
  const payload = json as LatestPayload;
  if (payload.attempt === null) return { kind: "none" };
  const attempt = payload.attempt as unknown;
  if (typeof attempt !== "object") return { kind: "unusable" };
  const { id, state } = attempt as { id?: unknown; state?: unknown };
  if (typeof id !== "string" || id === "" || typeof state !== "string" || !KNOWN_ATTEMPT_STATES.has(state)) return { kind: "unusable" };
  if (TERMINAL_ATTEMPT_STATES.has(state)) return { kind: "terminal" };
  return { kind: "active", payload, attempt: payload.attempt };
}

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

/**
 * L-2 D-4: fixed client copy for a submit that ended without an answer this
 * page can act on (a refusal it cannot interpret, a server error, a network
 * failure, an unreadable reply). The server's sentence and raw network/parse
 * text are never shown; nothing here says the payment was or was not sent.
 */
export const SUBMIT_UNCONFIRMED_MESSAGE = "We couldn't confirm whether this payment was sent. Check its status before trying again.";

/**
 * L-2 D-8: fixed client copy for an HTTP 401 / 404 from POST /submit or GET
 * /status. Neither status proves the payment was never sent, so neither text
 * says so; the server's own sentence is never shown.
 */
export const SIGNED_OUT_PAYMENT_MESSAGE = "You're signed out, so we can't confirm this payment yet. Sign in again to check its status.";
export const PAYMENT_NOT_ACCESSIBLE_MESSAGE = "We can't check this payment with the current sign-in. It may still have gone through. Check that you're using the account that started it.";

/**
 * L-2 D-8: the ONE place a 401 / 404 is recognised — `error instanceof
 * ApiError` and the status EXACTLY 401 or 404. No message matching, and no
 * other 4xx (400, 403, 409, 429 …) or network / non-JSON failure qualifies.
 */
function classifySessionFailure(error: unknown): { reason: "signed_out" | "not_accessible"; message: string } | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 401) return { reason: "signed_out", message: SIGNED_OUT_PAYMENT_MESSAGE };
  if (error.status === 404) return { reason: "not_accessible", message: PAYMENT_NOT_ACCESSIBLE_MESSAGE };
  return null;
}

/**
 * L-2 D-6: the client's own bound on one POST /submit, counted from the moment
 * the request is sent (never during the passkey prompt). It ends OUR wait only:
 * the request is NOT aborted, and the server may still be working on it — the
 * outcome is then simply unknown, never "failed" and never "not sent".
 */
export const SUBMIT_REQUEST_DEADLINE_MS = 60_000;

/**
 * L-2 D-4: the ONE submit refusal that is definitive about THIS request — HTTP
 * 409 AND the body's `code` exactly "wrong_passkey". The server decides it
 * before this request's claim, budget charge or any provider call, on a row it
 * found still awaiting authorization: this request sent nothing, and this
 * session's passkey can never approve the payment. Exact status and exact
 * string only: no sentence matching, no case folding, no trimming. Every other
 * 409 (no code, `wrong_state`, another or a non-string code) stays "unknown".
 * It says nothing about what another signed-in session may do with the same
 * payment — Cancel stays the server's decision.
 */
function isWrongPasskeyRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "wrong_passkey";
}

/**
 * L-2 D-7: the attempt states an HTTP 200 from POST /submit can honestly carry
 * (resolveSubmitPayment: submitted, failed, unknown — and `signed` /
 * `submitting` when a state-conditional write is lost and the stored row is
 * returned). Deliberately narrower than KNOWN_ATTEMPT_STATES: this route never
 * answers `confirmed` (that comes only from the status path), nor `prepared`,
 * `awaiting_authorization` or `cancelled`.
 */
const SUBMIT_RESPONSE_STATES: ReadonlySet<string> = new Set<RealPaymentAttemptState>(["signed", "submitting", "submitted", "failed", "unknown"]);

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * L-2 D-7: is this submit HTTP 200 body the attempt THIS request submitted,
 * in a shape the page can safely show? Pure; strict; no trimming, case folding
 * or repair. It checks only what the submit-response-to-render path reads: the
 * id (exactly the submitted id), the state (the allow-list above), the
 * recipient and amount (exactly the held attempt's — a payment's intent never
 * changes after prepare), and failureReason / transactionHash, which the
 * server's serializer always sends as string-or-null and the form prints.
 * Additional keys are allowed and ignored. A rejection says nothing about what
 * happened to the payment.
 */
function isHonestSubmitResponse(json: unknown, held: { id: string; recipient: string; amountBaseUnits: string }): json is { attempt: RealPaymentAttempt } {
  if (!isJsonObject(json)) return false;
  const attempt = json.attempt;
  if (!isJsonObject(attempt)) return false;
  if (typeof attempt.id !== "string" || attempt.id !== held.id) return false;
  if (typeof attempt.state !== "string" || !SUBMIT_RESPONSE_STATES.has(attempt.state)) return false;
  if (typeof attempt.recipient !== "string" || attempt.recipient !== held.recipient) return false;
  if (typeof attempt.amountBaseUnits !== "string" || !/^\d+$/.test(attempt.amountBaseUnits) || attempt.amountBaseUnits !== held.amountBaseUnits) return false;
  if (attempt.failureReason !== null && typeof attempt.failureReason !== "string") return false;
  if (attempt.transactionHash !== null && typeof attempt.transactionHash !== "string") return false;
  return true;
}

/**
 * L-2 D-10: is this GET /status HTTP 200 body the attempt THIS page holds, in a
 * shape the page can safely adopt and show? Pure; strict; no trimming, case
 * folding, rounding or repair. Sibling of isHonestSubmitResponse, but a status
 * answer can honestly carry ANY of the nine states (the server reads the stored
 * row, and may have moved it), so it uses KNOWN_ATTEMPT_STATES — never the
 * narrower submit allow-list, and never a comparison with the previous local
 * state. It checks what the status-response-to-render path reads: a finite
 * serverNowSeconds (it feeds the advisory clock offset), the id (exactly the
 * held id), the state, the recipient and amount (exactly the held attempt's —
 * a payment's intent never changes after prepare), failureReason /
 * transactionHash (always string-or-null from the server's serializer, and
 * printed by the form), and `prepared` only as null-versus-object PRESENCE
 * (its contents are not inspected here), one-way and state-aware: a held object
 * must stay an object, in a state other than `prepared`; a held null stays null, except that a row held in state
 * `prepared` (reserved, fields not yet written) may honestly come back with the
 * completed object in any state other than `prepared`. An answer in state
 * `prepared` never carries the object, whatever the page held. Additional
 * keys are allowed and ignored; reconciliationDeferred / retryAfterSeconds stay
 * with interpretStatusResult. A rejection says nothing about what happened to
 * the payment.
 */
function isHonestStatusResponse(json: unknown, held: RealPaymentAttempt): json is StatusResult {
  if (!isJsonObject(json)) return false;
  if (typeof json.serverNowSeconds !== "number" || !Number.isFinite(json.serverNowSeconds)) return false;
  const attempt = json.attempt;
  if (!isJsonObject(attempt)) return false;
  if (typeof attempt.id !== "string" || attempt.id !== held.id) return false;
  if (typeof attempt.state !== "string" || !KNOWN_ATTEMPT_STATES.has(attempt.state)) return false;
  if (typeof attempt.recipient !== "string" || attempt.recipient !== held.recipient) return false;
  if (typeof attempt.amountBaseUnits !== "string" || !/^\d+$/.test(attempt.amountBaseUnits) || attempt.amountBaseUnits !== held.amountBaseUnits) return false;
  if (attempt.failureReason !== null && typeof attempt.failureReason !== "string") return false;
  if (attempt.transactionHash !== null && typeof attempt.transactionHash !== "string") return false;
  // `prepared`: presence only (contents are never inspected), one-way and state-aware.
  const heldPrepared = held.prepared as unknown;
  if (isJsonObject(heldPrepared)) {
    // Fields never disappear from a stored row (object -> null is not an honest answer), and no transition targets `prepared`:
    // an answer in state `prepared` never carries the object, whatever the page held.
    if (!isJsonObject(attempt.prepared) || attempt.state === "prepared") return false;
  } else if (heldPrepared === null) {
    // A held null stays null — except for a row held in the `prepared` state: the server reserves it without fields and its own
    // atomic `prepared -> awaiting_authorization` write adds them, so a later honest answer may carry them, in a state past `prepared`.
    if (attempt.prepared !== null && (held.state !== "prepared" || attempt.state === "prepared" || !isJsonObject(attempt.prepared))) return false;
  } else {
    return false;
  }
  return true;
}

/**
 * L-2 D-11: is this POST /cancel HTTP 200 body an honest "this payment was
 * cancelled"? Pure; strict; no trimming, case folding or repair. Sibling of the
 * submit and status validators, narrower than both: a successful Cancel
 * discards the answer's attempt (it is never adopted), so this checks only what
 * the confirmation itself claims — `{ attempt }` with the id exactly the held
 * id, state exactly `cancelled`, the recipient and amount exactly the held
 * attempt's (a payment's intent never changes after prepare), and
 * transactionHash exactly null (a pre-dispatch row never has one). `prepared`
 * is deliberately NOT inspected: the server answers cancelled/null for a row it
 * reserved without fields and cancelled/object for a completed one — and a page
 * that held prepared/null may honestly get cancelled/object when preparation
 * finished before Cancel — and nothing here reads it. failureReason,
 * recipientIdentity, the timestamps and any other key are ignored; no
 * serverNowSeconds is required. A rejection says nothing about whether the
 * payment was cancelled.
 */
function isHonestCancelResponse(json: unknown, held: { id: string; recipient: string; amountBaseUnits: string }): boolean {
  if (!isJsonObject(json)) return false;
  const attempt = json.attempt;
  if (!isJsonObject(attempt)) return false;
  if (typeof attempt.id !== "string" || attempt.id !== held.id) return false;
  if (attempt.state !== "cancelled") return false;
  if (typeof attempt.recipient !== "string" || attempt.recipient !== held.recipient) return false;
  if (typeof attempt.amountBaseUnits !== "string" || !/^\d+$/.test(attempt.amountBaseUnits) || attempt.amountBaseUnits !== held.amountBaseUnits) return false;
  if (attempt.transactionHash !== null) return false;
  return true;
}

/**
 * L-2 D-12: what THIS prepare request asked for, captured from its own request
 * body before the await — never re-read from the live form afterwards. Exactly
 * one selector: the canonical address sent, or the canonical handle sent.
 */
type PrepareIntent = { readonly kind: "address"; readonly recipient: string; readonly amountBaseUnits: string } | { readonly kind: "handle"; readonly handle: string; readonly amountBaseUnits: string };

/** L-2 D-12 runtime format rules for the wire `prepared` object. Shape only: nothing is decoded, converted, hashed or compared with the payment's intent. */
const PREPARED_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
/** A handle payment's server-resolved recipient: pg_catalog.lower(safe_address), so lower-case only. */
const LOWERCASE_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const DECIMAL_DIGITS_PATTERN = /^[0-9]+$/;
const HEX_BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const PREPARED_DECIMAL_FIELDS = ["nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas"] as const;
const PREPARED_NULLABLE_DECIMAL_FIELDS = ["paymasterVerificationGasLimit", "paymasterPostOpGasLimit"] as const;
const PREPARED_NULLABLE_ADDRESS_FIELDS = ["factory", "paymaster"] as const;
const PREPARED_NULLABLE_HEX_FIELDS = ["factoryData", "paymasterData"] as const;

const isPrimitiveMatch = (value: unknown, pattern: RegExp): boolean => typeof value === "string" && pattern.test(value);
/** Present (a missing key is rejected) and either null or a string of the given format. */
const isNullableMatch = (fields: Record<string, unknown>, key: string, pattern: RegExp): boolean => key in fields && (fields[key] === null || isPrimitiveMatch(fields[key], pattern));

/**
 * L-2 D-12: does `prepared` have the runtime shape server/payments.ts's
 * toPublicAttempt serializes (WirePreparedFields)? Addresses 0x + 40 hex (any
 * case — the Safe sender and the provider's factory / paymaster keep their
 * casing), decimal fields ASCII digit strings (bigint.toString()), hex data
 * whole bytes ("0x" allowed), every nullable key present, validUntil a positive
 * safe integer. Not a verification of what the operation does.
 */
function isWellFormedPreparedFields(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  if (!isPrimitiveMatch(value.sender, PREPARED_ADDRESS_PATTERN)) return false;
  if (!isPrimitiveMatch(value.callData, HEX_BYTES_PATTERN)) return false;
  for (const key of PREPARED_DECIMAL_FIELDS) if (!isPrimitiveMatch(value[key], DECIMAL_DIGITS_PATTERN)) return false;
  for (const key of PREPARED_NULLABLE_DECIMAL_FIELDS) if (!isNullableMatch(value, key, DECIMAL_DIGITS_PATTERN)) return false;
  for (const key of PREPARED_NULLABLE_ADDRESS_FIELDS) if (!isNullableMatch(value, key, PREPARED_ADDRESS_PATTERN)) return false;
  for (const key of PREPARED_NULLABLE_HEX_FIELDS) if (!isNullableMatch(value, key, HEX_BYTES_PATTERN)) return false;
  return typeof value.validUntil === "number" && Number.isSafeInteger(value.validUntil) && value.validUntil > 0;
}

/**
 * L-2 D-12: is this prepare HTTP 200 body the payment THIS request asked for, in
 * the shape resolvePreparePayment's "ready" answer has, before anything is
 * adopted or signed? Pure; strict; no trimming, case folding, coercion or
 * repair. Sibling of the submit, status and Cancel validators (untouched).
 *
 * - Signing context: subOrganizationId and authorizingCredentialId non-empty
 *   strings (presence and type only — not proof they are the right ones);
 *   serverNowSeconds a finite number.
 * - attempt: id a server-issued UUID (isValidUuid); state exactly
 *   awaiting_authorization; amount the digit string sent; transactionHash and
 *   failureReason exactly null (missing rejected); `prepared` well formed.
 * - Recipient: an address payment answers exactly the canonical address sent,
 *   with recipientIdentity exactly null. A handle payment answers a lower-case
 *   address (the server resolves it; the client has no expectation for it)
 *   and a strict identity (readRecipientIdentity) whose handle is exactly the
 *   handle sent; its display name is the server's snapshot and is not compared
 *   with the earlier lookup.
 *
 * createdAt / updatedAt and extra keys are ignored. A rejection says nothing
 * about whether the server reserved or prepared the payment.
 */
function isHonestPrepareResponse(json: unknown, intent: PrepareIntent): json is { attempt: RealPaymentAttempt; subOrganizationId: string; authorizingCredentialId: string; serverNowSeconds: number } {
  if (!isJsonObject(json)) return false;
  if (typeof json.serverNowSeconds !== "number" || !Number.isFinite(json.serverNowSeconds)) return false;
  if (typeof json.subOrganizationId !== "string" || json.subOrganizationId === "") return false;
  if (typeof json.authorizingCredentialId !== "string" || json.authorizingCredentialId === "") return false;
  const attempt = json.attempt;
  if (!isJsonObject(attempt)) return false;
  if (typeof attempt.id !== "string" || !isValidUuid(attempt.id)) return false;
  if (attempt.state !== "awaiting_authorization") return false;
  if (typeof attempt.amountBaseUnits !== "string" || !/^\d+$/.test(attempt.amountBaseUnits) || attempt.amountBaseUnits !== intent.amountBaseUnits) return false;
  if (attempt.transactionHash !== null || attempt.failureReason !== null) return false;
  if (intent.kind === "address") {
    if (typeof attempt.recipient !== "string" || attempt.recipient !== intent.recipient) return false;
    if (attempt.recipientIdentity !== null) return false;
  } else {
    if (!isPrimitiveMatch(attempt.recipient, LOWERCASE_ADDRESS_PATTERN)) return false;
    const identity = readRecipientIdentity(attempt.recipientIdentity);
    if (identity === null || identity.handle !== intent.handle) return false;
  }
  return isWellFormedPreparedFields(attempt.prepared);
}

/**
 * L-2 D-13: is this GET /latest HTTP 200 body an answer the page may act on —
 * release D-1's prepare uncertainty, leave D-3a's unavailable state, or adopt a
 * payment and its signing context? Pure; strict; no trimming, case folding,
 * coercion or repair. Sibling of the submit, status, Cancel and prepare
 * validators (untouched); readLatestForCheck and adoptLatestAttempt still run
 * unchanged after it.
 *
 * - Empty: `attempt` exactly null (a missing or undefined attempt is not
 *   empty), with subOrganizationId / authorizingCredentialId each absent or
 *   null. No clock is required.
 * - Payment: a finite serverNowSeconds and an object attempt with an
 *   isValidUuid id, one of the nine known states (the route returns the stored
 *   row as is — terminal ones included), a 0x + 40-hex recipient (any case), a
 *   non-empty ASCII-digit amount, transactionHash / failureReason each null or
 *   a string (missing rejected), and `prepared` null or an object (missing
 *   rejected; exactly null in state `prepared`). Recipient and amount are NOT
 *   compared with the form: a recovered payment is the server's, not the draft.
 * - Signing context: both keys present, and either both null, or both
 *   non-empty strings on an awaiting_authorization attempt whose `prepared` is
 *   well formed (isWellFormedPreparedFields) — the one combination that can
 *   reach the passkey prompt. Shape only: not proof of credential ownership,
 *   and nothing is decoded or compared with the payment's intent.
 *
 * recipientIdentity (the display falls back to the address on its own),
 * createdAt / updatedAt and extra keys are ignored. A rejection says nothing
 * about whether any payment exists.
 */
function isHonestLatestResponse(json: unknown): boolean {
  if (!isJsonObject(json)) return false;
  const attempt = json.attempt;
  if (attempt === null) {
    return (!("subOrganizationId" in json) || json.subOrganizationId === null) && (!("authorizingCredentialId" in json) || json.authorizingCredentialId === null);
  }
  if (typeof json.serverNowSeconds !== "number" || !Number.isFinite(json.serverNowSeconds)) return false;
  if (!isJsonObject(attempt)) return false;
  if (typeof attempt.id !== "string" || !isValidUuid(attempt.id)) return false;
  if (typeof attempt.state !== "string" || !KNOWN_ATTEMPT_STATES.has(attempt.state)) return false;
  if (!isPrimitiveMatch(attempt.recipient, PREPARED_ADDRESS_PATTERN)) return false;
  if (!isPrimitiveMatch(attempt.amountBaseUnits, DECIMAL_DIGITS_PATTERN)) return false;
  if (attempt.transactionHash !== null && typeof attempt.transactionHash !== "string") return false;
  if (attempt.failureReason !== null && typeof attempt.failureReason !== "string") return false;
  if (attempt.prepared !== null && !isJsonObject(attempt.prepared)) return false;
  if (attempt.state === "prepared" && attempt.prepared !== null) return false;
  if (!("subOrganizationId" in json) || !("authorizingCredentialId" in json)) return false;
  const { subOrganizationId, authorizingCredentialId } = json;
  if (subOrganizationId === null && authorizingCredentialId === null) return true;
  if (typeof subOrganizationId !== "string" || subOrganizationId === "" || typeof authorizingCredentialId !== "string" || authorizingCredentialId === "") return false;
  return attempt.state === "awaiting_authorization" && isWellFormedPreparedFields(attempt.prepared);
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
  /**
   * L-2 D-6: arms the ONE client deadline for the submit request about to be
   * sent. `onDeadline` runs only if this very request is still the active one
   * when SUBMIT_REQUEST_DEADLINE_MS passes (not stopped, not superseded, not
   * dropped by a lifecycle change). Returns the function that stops it — called
   * the moment the request settles. Nothing is aborted.
   */
  startSubmitDeadline: (onDeadline: () => void) => () => void;
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
        // L-1b: the held attempt's own recipient and amount — the same snapshot
        // as `fields` above, never the live form, a lookup or a later get().
        expected: { recipient: attempt.recipient, amountBaseUnits: attempt.amountBaseUnits },
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
  set({ status: "submitting", isAuthorizing: false, pendingSubmission: signed, error: null, sessionRecovery: null });
  // Another handler may have changed the payment while this one awaited: only
  // an attempt still waiting for approval, or still being sent, may be moved.
  const stillOpen = () => {
    const shown = get().status;
    return shown === "submitting" || shown === "awaiting_authorization";
  };

  // L-2 D-6: the client's own bound on this one request, started where the
  // request is (never during the passkey prompt above). The request keeps its
  // plain await — an answer is applied exactly when it always was — and is NOT
  // aborted: abandoning it proves nothing about the server. If the timer wins,
  // this request is decided: its outcome is "unknown", and whatever it later
  // answers (or rejects with) is dropped by `timedOut` — inside the try/catch,
  // so never unhandled — leaving the approval, the attempt and the account
  // context exactly as they are for the user's own explicit Check status.
  let timedOut = false;
  const stopDeadline = hooks.startSubmitDeadline(() => {
    timedOut = true;
    // Only the lifecycle, attempt and account that sent it, and only while it is still shown as sending.
    if (!isCurrent() || get().status !== "submitting") return;
    markTransition();
    set({ status: "unknown", error: SUBMIT_UNCONFIRMED_MESSAGE, sessionRecovery: null });
  });
  try {
    const result = await api<{ attempt: RealPaymentAttempt }>("/api/real/payments/submit", {
      method: "POST",
      body: JSON.stringify({ attemptId: signed.attemptId, signature: signed.signature, activityId: signed.activityId }),
    });
    stopDeadline();
    // After the deadline this request was already answered for: its late answer is dropped, whatever it says.
    if (timedOut) return;
    // The server did answer, so its answer is the payment's state — but only
    // for the context that asked. (After an unmount the next init() reads it.)
    if (!isCurrent()) return;
    // L-2 D-7: a 200 that is not this request's own attempt in a showable shape
    // is NOT adopted — it proves nothing about the payment. Explicit rejection
    // (no throw): the held attempt, the retained approval, the credential and
    // the account context stay exactly as they are; the page says only that it
    // could not confirm, and nothing is checked, retried, signed, cancelled or
    // refreshed automatically — the user's own Check status is the way forward.
    // Runs after the D-6 and lifecycle guards above, never before them.
    if (!isHonestSubmitResponse(result as unknown, { id: attempt.id, recipient: attempt.recipient, amountBaseUnits: attempt.amountBaseUnits })) {
      if (!stillOpen()) return;
      markTransition();
      set({ status: "unknown", error: SUBMIT_UNCONFIRMED_MESSAGE, sessionRecovery: null });
      return;
    }
    const nextStatus = mapAttemptStateToStatus(result.attempt.state);
    const shown = get().status;
    // Terminal is final: a late answer never moves a confirmed or failed payment to anything else.
    if ((shown === "confirmed" || shown === "failed") && nextStatus !== shown) {
      set({ pendingSubmission: null });
      return;
    }
    markTransition();
    set({ status: nextStatus, attempt: result.attempt, pendingSubmission: null, error: null, sessionRecovery: null });
    if (result.attempt.state === "confirmed") void useRealBalanceStore.getState().fetchBalance();
  } catch (error) {
    stopDeadline();
    // A late rejection (network failure, abort-ignoring fetch) after the deadline is dropped like a late answer.
    if (timedOut) return;
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
    if (isWrongPasskeyRefusal(error)) {
      // L-2 D-4: the server refused THIS request before any claim or dispatch —
      // the payment is bound to another passkey, so nothing this session signs
      // can ever send it. The same cancel-only screen a reload gives: the
      // approval and the credential it was made with are dropped (Continue can
      // neither re-send nor prompt again), the attempt and the account context
      // stay. Nothing is cancelled, retried, signed, prepared or sent because of
      // it. The existing expiry schedule is re-armed for the screen now shown,
      // exactly as on every other return to a waiting screen: one timer for the
      // moment the approval window ends — or, if it has ALREADY ended, that
      // schedule's own read-only status check, under its usual stale guards.
      markTransition();
      set({ status: "stranded", authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false, error: OTHER_PASSKEY_MESSAGE });
      await scheduleExpiryCheck();
      return;
    }
    // A thrown error here means either a definitive HTTP-level refusal or a
    // network failure after a signature exists (the request may have
    // reached the server, or even the bundler, before failing) — either way
    // this is genuinely ambiguous and must never unlock an automatic resend.
    // L-2 D-8: an exact HTTP 401 / 404 is the same "unknown" with the same
    // retained attempt, approval and context — only the fixed wording differs
    // (and the marker that lets the screen offer the explicit session check).
    // Neither proves the payment was not sent; nothing is retried or checked.
    // The approval stays in memory: if a status check later shows the
    // attempt still awaiting, "Continue" re-sends it (the server's CAS keeps
    // that to at most one dispatch) rather than asking for a new signature.
    // L-2 D-4: the detail shown is fixed — never the server's sentence, a state
    // name, or raw network/parse text.
    markTransition();
    const sessionFailure = classifySessionFailure(error);
    set({ status: "unknown", error: sessionFailure?.message ?? SUBMIT_UNCONFIRMED_MESSAGE, sessionRecovery: sessionFailure?.reason ?? null });
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
  // L-2 D-1: at most one explicit prepared-payment check (one /latest read) and
  // one Cancel request in flight per lifecycle. Identity markers, not booleans:
  // a lifecycle change drops them, and a late settle never clears a newer one.
  let preparedCheck: object | null = null;
  let cancelRequest: object | null = null;
  // L-2 D-6: at most ONE submit deadline timer per store — the active submit
  // request's. An identity marker, not a boolean: a stopped, superseded or
  // lifecycle-dropped request's timer can never act for a newer one.
  let submitRequest: { timerId: ReturnType<typeof setTimeout> } | null = null;

  /** Ends the active submit request's deadline timer, if any. Idempotent; the request itself is untouched. */
  function clearSubmitRequestDeadline() {
    if (submitRequest !== null) {
      clearTimeout(submitRequest.timerId);
      submitRequest = null;
    }
  }

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
    // Their answers are discarded by the generation check; this frees the slots for the new lifecycle.
    preparedCheck = null;
    cancelRequest = null;
    // L-2 D-6: a submit request's deadline never outlives its lifecycle (the request's own answer is discarded by its generation check).
    clearSubmitRequestDeadline();
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
        // These guards run FIRST: a stale answer — malformed or not — never reaches the current lifecycle.
        if (!isCurrent() || read.epoch !== statusEpoch) return;
        // L-2 D-10: nothing in the answer is read, adopted or acted on until it is known to be this payment's own, well-formed;
        // a rejection takes the existing unusable-answer branch below.
        const verdict = isHonestStatusResponse(result as unknown, attempt) ? interpretStatusResult(result) : ({ kind: "malformed" } as const);
        if (verdict.kind === "malformed") {
          // The attempt in this answer is not trusted either: keep the last reliable one, back off, say so plainly.
          noteDeferral(attempt.id, null);
          // An answered read (even an unusable one) proves the session works: no sign-in prompt for it.
          set({ error: STATUS_UNUSABLE_MESSAGE, sessionRecovery: null });
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
          sessionRecovery: null,
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
          // L-2 D-8: an exact 401 / 404 gets fixed wording and the marker for the explicit session check. Nothing else changes —
          // the status, attempt, approval and cooldown stay as they were, and nothing is requested because of it. Any other failure
          // keeps its existing wording and leaves an earlier marker as it was (the lifecycle clears it).
          const sessionFailure = classifySessionFailure(error);
          if (sessionFailure) set({ error: sessionFailure.message, sessionRecovery: sessionFailure.reason });
          else set({ error: error instanceof StatusTimeoutError ? STATUS_TIMED_OUT_MESSAGE : error instanceof Error ? error.message : "Could not check payment status." });
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
      startSubmitDeadline: (onDeadline) => {
        // A submit starts only from a screen with no request in flight; a leftover marker is dropped, never allowed to act.
        clearSubmitRequestDeadline();
        const marker: { timerId: ReturnType<typeof setTimeout> } = {
          timerId: setTimeout(() => {
            // Stopped, superseded or dropped with its lifecycle: not this request's deadline any more.
            if (submitRequest !== marker) return;
            submitRequest = null;
            onDeadline();
          }, SUBMIT_REQUEST_DEADLINE_MS),
        };
        submitRequest = marker;
        return () => {
          if (submitRequest !== marker) return;
          clearTimeout(marker.timerId);
          submitRequest = null;
        };
      },
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

    /**
     * Adopts the server's latest attempt as the payment on screen — the single
     * mapping shared by init() (reload) and checkPreparedPayment() (L-2 D-1).
     * It never signs, submits, prepares or cancels. Slice S1: awaiting a
     * signature with no signing context means this session's passkey isn't the
     * one the payment is bound to (or it predates binding) — cancel-only, never
     * re-bound here. `extra` is merged into the one state write.
     */
    async function adoptLatestAttempt(json: LatestPayload, attempt: RealPaymentAttempt, extra: Partial<RealPaymentStore> = {}): Promise<void> {
      const notResumable = attempt.state === "awaiting_authorization" && (!json.subOrganizationId || !json.authorizingCredentialId);
      set({
        status: notResumable ? "stranded" : mapAttemptStateToStatus(attempt.state),
        attempt,
        subOrganizationId: json.subOrganizationId ?? null,
        authorizingCredentialId: json.authorizingCredentialId ?? null,
        clockOffsetSeconds: typeof json.serverNowSeconds === "number" ? computeClockOffsetSeconds(json.serverNowSeconds) : 0,
        error: notResumable ? OTHER_PASSKEY_MESSAGE : null,
        sessionRecovery: null,
        ...extra,
      });
      // A retry deadline the server gave for THIS attempt and account still applies after a remount.
      const waiting = remainingDeadlineMs(attempt.id);
      if (waiting > 0) {
        set({ isStatusDeferred: true, statusRetryAfterSeconds: statusDeadline?.serverSeconds ?? null });
        beginManualCooldown(waiting);
      }
      // Same account, same attempt: the submit wait the server gave still applies. A different attempt or account finds none.
      if (attempt.state === "awaiting_authorization") publishSubmitCooldown(attempt);
      await scheduleOrRunExpiryCheck();
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
      prepareNeedsCheck: null,
      prepareCheck: "idle",
      sessionRecovery: null,
      isCancelling: false,
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
        set({ status: "idle", recipientInput: "", recipientLookup: { status: "idle" }, amountInput: "", attempt: null, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false, isManualCheckCoolingDown: false, isFollowUpExhausted: false, isStatusDeferred: false, statusRetryAfterSeconds: null, isSubmitCoolingDown: false, submitCooldownSeconds: null, isSubmitRetryBeyondApproval: false, prepareNeedsCheck: null, prepareCheck: "idle", sessionRecovery: null, isCancelling: false, clockOffsetSeconds: 0, isAttemptPastValidity: false, error: null });
        // L-2 D-3a: the answer belongs to the lifecycle (generation) and account
        // that asked. Each init() is its own generation, so a newer init, a
        // reset, a detach or another account makes this one's answer — success,
        // failure or timeout alike — a no-op.
        const subject = currentSubject();
        const isCurrent = () => !detached && myGeneration === generation && currentSubject() === subject;
        // "We could not tell" — never "no payment": no attempt is shown, nothing may be prepared, and no raw error text is kept.
        const markUnavailable = () => set({ status: "status_unavailable", attempt: null, subOrganizationId: null, authorizingCredentialId: null, isAttemptPastValidity: false, error: null });

        // The client's own bound on this one read (headers AND body). It ends OUR
        // wait only: the server may still be working, and a timeout proves
        // nothing about any payment. Nothing is retried when it fires.
        //
        // This request is decided exactly once — by its own answer or by the
        // deadline, whichever comes first. The read keeps its plain awaits (an
        // answer is applied exactly when it always was); the timer ends the wait
        // on its own, and an answer or rejection that arrives after it is
        // dropped by `timedOut`, inside the try/catch — never unhandled.
        const controller = new AbortController();
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const stopTimer = () => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
        };

        const read = async (): Promise<void> => {
          try {
            const response = await fetch("/api/real/payments/latest", { signal: controller.signal });
            if (timedOut) return;
            // Only a 2xx carries an answer about payments; its body is read before anything is decided.
            const json: unknown = response.ok ? await response.json() : null;
            if (timedOut) return;
            // Answered: the timer is gone before anything is applied, so it can never fire over a restored payment.
            stopTimer();
            if (!isCurrent()) return;
            if (response.status === 401) {
              set({ status: "editing", attempt: null, subOrganizationId: null, isAttemptPastValidity: false });
              return;
            }
            // Any other non-2xx is not an answer about payments at all — whatever its body says.
            if (!response.ok) {
              markUnavailable();
              return;
            }
            // L-2 D-13: a 2xx that is not a well-formed answer is not one either — after the guards above, before anything is
            // classified or adopted, with no await in between. The same "we couldn't check" state; nothing is adopted or scheduled.
            if (!isHonestLatestResponse(json)) {
              markUnavailable();
              return;
            }
            // Fail closed, with D-1's reader: only an explicit `attempt: null` means "no payment".
            const latest = readLatestForCheck(json);
            if (latest.kind === "unusable") {
              markUnavailable();
              return;
            }
            if (latest.kind === "none") {
              set({ status: "editing", attempt: null, subOrganizationId: null, isAttemptPastValidity: false });
              return;
            }
            // A validated attempt (object, non-empty id, known state) — active OR
            // terminal. Unlike the D-1 check, a reload restores a finished payment
            // too (Sent / failed), exactly as before.
            const payload = json as LatestPayload;
            await adoptLatestAttempt(payload, payload.attempt as RealPaymentAttempt);
          } catch {
            // After the deadline this request has already been answered for: its late rejection (an abort included) is dropped.
            if (timedOut) return;
            stopTimer();
            // A network failure, an unreadable body, or anything unexpected: not evidence that no payment exists.
            if (isCurrent()) markUnavailable();
          }
        };

        // Resolves when the read is done with — or when the deadline ends the wait, even if the request itself never settles.
        await new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timer = null;
            timedOut = true;
            try {
              controller.abort();
              if (isCurrent()) markUnavailable();
            } finally {
              resolve();
            }
          }, STATUS_REQUEST_DEADLINE_MS);
          void read().then(resolve, resolve);
        });
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
        // L-2 D-3a: the latest payment is unknown — no review (and so no prepare) until a check succeeds. Enforced here, not only by the hidden form.
        if (get().status === "status_unavailable") return Promise.resolve();
        // L-2 D-1: an unresolved prepare must be checked first — enforced here, not only by the hidden button.
        if (get().prepareNeedsCheck !== null) return Promise.resolve();
        if (get().prepareCheck === "nothing_found") set({ prepareCheck: "idle" });
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

      editAgain: () => {
        // L-2 D-3a: not a way out of the unavailable state — only a successful check (or a new lifecycle) is.
        if (get().status === "status_unavailable") return;
        set({ status: "editing", error: null });
      },

      confirmAndSend: async () => {
        if (get().status === "status_unavailable") return; // L-2 D-3a: never prepare while the latest payment is unknown
        if (get().status !== "reviewing") return; // guards a double-tap from re-firing prepare
        if (get().prepareNeedsCheck !== null) return; // L-2 D-1: never prepare again over an unresolved prepare
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
        // L-2 D-12: the answer is checked against what THIS request sent — captured here, never the live form after the await.
        const intent: PrepareIntent = Object.freeze(view.kind === "address" ? { kind: "address", recipient: view.recipient, amountBaseUnits } : { kind: "handle", handle: view.handle, amountBaseUnits });

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
          // L-2 D-12: a 200 that is not this request's own payment, in the shape the server sends, is NOT adopted and NOT signed: it
          // proves nothing about whether a payment was reserved, so it takes D-1's uncertain-prepare state exactly — the typed text,
          // clock offset, cooldowns, timers and epoch stay; nothing is read, retried, cancelled or signed. After the guard above.
          if (!isHonestPrepareResponse(result as unknown, intent)) {
            set({ status: "editing", error: null, prepareNeedsCheck: "uncertain", prepareCheck: "idle" });
            return;
          }
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
          // L-2 D-2: the server refused this request outright (exact 409 + code) — no payment was started by it, so there is nothing to check. Back to the ordinary form with fixed copy and the typed text; nothing is read, retried, cancelled or signed. Checked BEFORE the D-1 classification, which would otherwise ask for a status check that can never resolve it.
          if (isAccountNotReadyRefusal(error)) {
            set({ status: "editing", error: PREPARE_ACCOUNT_NOT_READY_MESSAGE });
            return;
          }
          // L-2 D-1: no trustworthy answer — a payment may exist that this page never saw. Nothing is retried, read, cancelled or signed here; the typed text stays and the user is asked to check explicitly. A fixed message replaces the raw network/parse text.
          const unresolved = classifyPrepareFailure(error);
          if (unresolved) {
            set({ status: "editing", error: null, prepareNeedsCheck: unresolved, prepareCheck: "idle" });
            return;
          }
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
          // L-2 D-3a: nothing to cancel must not turn "we couldn't check" into the ordinary form.
          if (get().status !== "status_unavailable") set({ status: "editing" });
          return;
        }
        // L-2 D-1: one Cancel request at a time. A repeat press while it is on
        // its way does nothing — no second request, no local release.
        if (cancelRequest) return;
        const myGeneration = generation;
        const cancelSubject = currentSubject();
        // A reset/account switch/new attempt while in flight: this result no longer applies.
        const isCurrent = () => myGeneration === generation && get().attempt?.id === attempt.id && currentSubject() === cancelSubject;

        const myCancel = {};
        cancelRequest = myCancel;
        set({ isCancelling: true });
        // Frees the slot once THIS request has an answer (or failed). A newer lifecycle already dropped it, and must not be touched.
        const releaseCancel = () => {
          if (cancelRequest !== myCancel) return;
          cancelRequest = null;
          set({ isCancelling: false });
        };

        let response: Response;
        try {
          response = await fetch(`/api/real/payments/${attempt.id}/cancel`, { method: "POST" });
        } catch {
          releaseCancel();
          // Part D: a network-level failure means we don't know whether the
          // request ever reached the server — never imply cancellation
          // succeeded and never reset to a fresh editable state on a guess.
          // Preserve the existing attempt/status exactly as they were.
          if (isCurrent()) set({ error: CANCEL_UNCONFIRMED_MESSAGE });
          return;
        }
        if (response.ok) {
          // L-2 D-11: the confirmation is read while THIS request still owns the slot (a repeat press during the body read must not
          // dispatch a second POST). Everything after the final await — release, guard, validation, result — is synchronous.
          let body: unknown;
          let bodyReadable = true;
          try {
            body = await response.json();
          } catch {
            bodyReadable = false;
          }
          releaseCancel();
          if (!isCurrent()) return;
          if (!bodyReadable || !isHonestCancelResponse(body, attempt)) {
            // An unreadable or mismatched confirmation proves nothing either way: same neutral message as a network failure, payment untouched.
            set({ error: CANCEL_UNCONFIRMED_MESSAGE });
            return;
          }
          clearExpiryTimeout();
          clearSubmitRequestDeadline();
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
            sessionRecovery: null,
            error: null,
          });
          return;
        }

        // Non-2xx: never parsed by the success check above.
        releaseCancel();
        if (!isCurrent()) return;

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
          if (!isCurrent() || read.epoch !== statusEpoch) return;
          // L-2 D-10: the same status answer, the same check — after the guards, before any field is read. Same fallback as an unusable deferral.
          const verdict = isHonestStatusResponse(result as unknown, attempt) ? interpretStatusResult(result) : ({ kind: "malformed" } as const);
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
            sessionRecovery: null,
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

      checkPreparedPayment: async () => {
        const before = get();
        // Only from the editing screen, only while a check is required, never while detached, and never overlapping.
        if (detached || before.status !== "editing" || before.prepareNeedsCheck === null || preparedCheck !== null) return;
        const myCheck = {};
        preparedCheck = myCheck;
        const myGeneration = generation;
        const subject = currentSubject();
        // After the await the call must still belong to the same lifecycle and account, still on the form, still needing the check.
        const isCurrent = () => !detached && preparedCheck === myCheck && myGeneration === generation && currentSubject() === subject && get().status === "editing" && get().prepareNeedsCheck !== null;
        set({ prepareCheck: "checking" });

        // The client's own bound on this one read: ends OUR wait only, and proves nothing about any payment.
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | null = null;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new StatusTimeoutError());
          }, STATUS_REQUEST_DEADLINE_MS);
        });
        try {
          // Exactly one read, and nothing else: no prepare, cancel, status, signing or submit.
          const json = await Promise.race([api<unknown>("/api/real/payments/latest", { signal: controller.signal }), deadline]);
          if (!isCurrent()) return;
          // L-2 D-13: a malformed answer never releases the requirement or adopts anything — after the guard, before classification.
          // The same failed-check line as an unreadable reply; prepareNeedsCheck, the draft, error, timers and epoch stay as they are.
          if (!isHonestLatestResponse(json)) {
            set({ prepareCheck: "unavailable" });
            return;
          }
          const latest = readLatestForCheck(json);
          if (latest.kind === "unusable") {
            // An answer we can't trust is never "no payment": the requirement stays.
            set({ prepareCheck: "unavailable" });
            return;
          }
          preparedCheck = null;
          if (latest.kind === "none" || latest.kind === "terminal") {
            // No ACTIVE payment. A finished one (even a confirmed one) is old news, not this form's result: nothing is adopted or shown as sent.
            set({ prepareNeedsCheck: null, prepareCheck: "nothing_found", error: null });
            return;
          }
          // An active payment: the server's record, not the form, is the truth. It joins the normal payment lifecycle (epoch bump included, so an older status read can't overwrite it).
          markTransition();
          await adoptLatestAttempt(latest.payload, latest.attempt, { prepareNeedsCheck: null, prepareCheck: "idle", pendingSubmission: null, isAuthorizing: false });
        } catch (error) {
          if (!isCurrent()) return;
          if (error instanceof ApiError && error.status === 401) {
            // Signed out is not "no payment": the requirement stays, and the sign-in flow takes over.
            set({ prepareCheck: "idle", error: "You're signed out." });
            return;
          }
          set({ prepareCheck: "unavailable" });
        } finally {
          if (timer !== null) clearTimeout(timer);
          if (preparedCheck === myCheck) preparedCheck = null;
        }
      },

      checkPaymentsAgain: async () => {
        // Only from the unavailable screen, never while detached. init() enters
        // "idle" synchronously, so a second press finds nothing to do: one GET
        // /latest per successful press, and nothing else.
        if (detached || get().status !== "status_unavailable") return;
        await get().init();
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
        set({ isManualCheckCoolingDown: false, isStatusDeferred: false, isSubmitCoolingDown: false, isCancelling: false, sessionRecovery: null, ...(get().prepareCheck === "checking" ? { prepareCheck: "idle" as const } : {}) });
      },

      reset: () => {
        generation++;
        lookupSequence++;
        clearFollowUpState();
        // A new compose flow / sign-out: the previous attempt's deadline has nothing left to govern.
        clearDeadline();
        submitCooldown = null;
        set({ isManualCheckCoolingDown: false, isFollowUpExhausted: false, isStatusDeferred: false, statusRetryAfterSeconds: null, isSubmitCoolingDown: false, submitCooldownSeconds: null, isSubmitRetryBeyondApproval: false, prepareNeedsCheck: null, prepareCheck: "idle", sessionRecovery: null, isCancelling: false, status: "editing", recipientLookup: { status: "idle" }, attempt: null, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false, recipientInput: "", amountInput: "", error: null });
      },
    };
  });
}

export const useRealPaymentStore = createRealPaymentStore();
