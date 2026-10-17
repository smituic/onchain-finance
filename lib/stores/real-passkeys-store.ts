import { create } from "zustand";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { isWebAuthnCancellation, performLoginCeremony, performRegistrationCeremony } from "@/lib/real/account/webauthn-client";
import {
  stampCreateAuthenticatorsRequest,
  stampDeleteAuthenticatorsRequest,
  type CreateAuthenticatorsActivity,
  type DeleteAuthenticatorsActivity,
} from "@/lib/real/signing/authenticator-requests";
import { signDigestViaTurnkeyRaw } from "@/lib/real/signing/raw-sign";
import {
  PASSKEY_REMOVED_MESSAGE,
  backupCheckWaitMessage,
  removalCheckWaitBase,
  removalCheckWaitMessage,
  reviewCheckWaitMessage,
  signingCheckWaitMessage,
  type PasskeyRole,
  type PasskeyStatus,
  type RemovalAttemptState,
} from "@/lib/real/display/passkey-status";
import { validatePasskeyDisplayName } from "@/lib/real/display/passkey-name";

/**
 * Client orchestration of backup-passkey setup and passkey removal. The
 * DURABLE server state is always the source of truth: every action first
 * reads it (/backup/status, the passkey list) and resumes from wherever it
 * actually is — never from anything this store remembered. The browser
 * only ever STAMPS Turnkey mutations (authenticator-requests.ts); the server
 * validates, records, and forwards them. No persist middleware, no
 * localStorage.
 *
 * S4: everything here belongs to ONE signed-in account. bindAccount()/reset()
 * start a new account generation; every action captures the generation it
 * started under and, once that is stale, applies nothing and stops before
 * its next server call — so a late response (or a half-finished setup or
 * removal flow) from account A can never write into account B's list, and
 * never continues under B's cookie.
 *
 * 3A-3 Stage 2A: the three requests the server charges to the per-account
 * Turnkey reconcile budget (backup reconcile, signing confirmation, removal
 * reconcile) go through chargedPost(). One server denial starts ONE shared,
 * in-memory, per-account wait; during it those three requests are refused
 * LOCALLY (no fetch), and a signing ceremony that could only end in a refused
 * confirmation is not started. Nothing else is gated — in particular the
 * original removal submit — and nothing ever retries by itself.
 */
export type RealPasskeySummary = {
  credentialId: string;
  role: PasskeyRole;
  /** Presentation only — null until renamed; see passkeyDisplayName for the fallback. */
  displayName: string | null;
  status: PasskeyStatus;
  credentialDeviceType: "singleDevice" | "multiDevice" | null;
  credentialBackedUp: boolean | null;
  createdAt: string;
  isCurrentSession: boolean;
  canAuthorizeRemovals: boolean;
  /** 2g-H: whether this credential may authorize at the wallet provider. Missing (older API) is treated as "may". */
  walletAccess?: "none" | "uncertain" | "granted";
  removal: { attemptId: string; state: RemovalAttemptState; ownedBySession: boolean } | null;
};

export type BackupEnrollmentState =
  | "started"
  | "credential_registered"
  | "turnkey_enrollment_in_flight"
  | "turnkey_authenticator_created"
  | "login_verified"
  | "active"
  | "abandoned"
  | "blocked"
  | "removal_in_progress"
  | "removed";

export type BackupEnrollmentStatus = { id: string; state: BackupEnrollmentState; externalOutcome: string; abandonable: boolean; blockReason: string | null };

export type RealPasskeysStore = {
  passkeys: RealPasskeySummary[];
  enrollment: BackupEnrollmentStatus | null;
  listStatus: "idle" | "loading" | "ready" | "error";
  listError: string | null;
  setupBusy: boolean;
  setupMessage: string | null;
  /** 3A-3: true while `setupMessage` is the temporary "can't check just yet" copy. It is dropped when the shared wait ends; never matched by its text. */
  setupMessageIsWait: boolean;
  setupError: string | null;
  removalBusyCredentialId: string | null;
  /** `waitBase`: set only on temporary wait copy — the truthful message that remains once the shared wait ends. */
  removalMessage: { credentialId: string; text: string; waitBase?: string } | null;
  removalError: string | null;
  renameBusyCredentialId: string | null;
  renameError: { credentialId: string; text: string } | null;
  /** 3A-3: true while the shared Turnkey-check wait is running. Published from the private deadline record; never persisted. */
  isTurnkeyCheckWaiting: boolean;
  /** 3A-3: the wait's length in whole seconds as of when it was recorded (no countdown), or null. */
  turnkeyCheckWaitSeconds: number | null;

  refresh: () => Promise<void>;
  continueBackupSetup: () => Promise<void>;
  abandonBackupSetup: () => Promise<void>;
  removePasskey: (credentialId: string) => Promise<void>;
  checkRemoval: (credentialId: string, attemptId: string) => Promise<void>;
  cancelRemoval: (credentialId: string, attemptId: string) => Promise<void>;
  /** Resolves true once the server accepted the name (the caller can close its editor). */
  renamePasskey: (credentialId: string, displayName: string) => Promise<boolean>;
  clearRenameError: () => void;
  /** Associates the store with the signed-in account; a different appUserId (or null on sign-out) resets it first. Same account again is a no-op, so remounting mid-flow keeps the flow alive. */
  bindAccount: (appUserId: string | null) => void;
  /** Clears all account-specific state and invalidates every in-flight action. */
  reset: () => void;
};

type Outcome = { outcome: string; reason?: string; reconciliationDeferred?: unknown; retryAfterSeconds?: unknown };

/** An HTTP error with what the server said about it. Local to this store (the payment store has its own). */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly retryable: boolean | null,
    /** The raw Retry-After header, unparsed — null when absent. */
    readonly retryAfter: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  // A non-JSON body (a proxy page, an empty 429) must not crash parsing into a SyntaxError.
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  const fields = json !== null && typeof json === "object" ? (json as { error?: unknown; code?: unknown; retryable?: unknown }) : {};
  if (!response.ok) {
    throw new ApiError(
      typeof fields.error === "string" && fields.error ? fields.error : `Request failed (${response.status})`,
      response.status,
      typeof fields.code === "string" ? fields.code : null,
      typeof fields.retryable === "boolean" ? fields.retryable : null,
      response.headers?.get("Retry-After") ?? null,
    );
  }
  if (json === null) throw new ApiError(`Request failed (${response.status})`, response.status, null, null, null);
  return json as T;
}

const post = <T>(url: string, body?: unknown) => api<T>(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RECONCILE_ATTEMPTS = 5;
const RECONCILE_DELAY_MS = 1500;
const MAX_SETUP_STEPS = 12;

/** Thrown (and swallowed) when an action's account generation went stale mid-flight — nothing more is sent or applied. */
class StaleAccountError extends Error {
  constructor() {
    super("The signed-in account changed.");
    this.name = "StaleAccountError";
  }
}

/** One action's view of the store: writes only while its account generation is current. */
type Scope = {
  live: () => boolean;
  /** Throws StaleAccountError once the generation is stale — called after every await, before the next server call. */
  check: () => void;
  put: (partial: Partial<RealPasskeysStore>) => void;
};

/** 3A-3: the longest delay the Turnkey reconcile policy can issue (its daily window); anything above is not a delay the server could have meant. */
export const MAX_TURNKEY_RETRY_AFTER_SECONDS = 86_400;
/** 3A-3: applied when a denial's delay is missing or unusable — never "retry now". */
export const TURNKEY_WAIT_FALLBACK_SECONDS = 60;

/** The same strict convention as the payment store's submit parsing: ASCII digits only, no leading zero, 1…86 400. Anything else is null. */
export function parseTurnkeyRetryAfter(header: string | null | undefined): number | null {
  if (typeof header !== "string" || !/^[1-9][0-9]{0,4}$/.test(header)) return null;
  const seconds = Number(header);
  return seconds <= MAX_TURNKEY_RETRY_AFTER_SECONDS ? seconds : null;
}

const isWholeDelay = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TURNKEY_RETRY_AFTER_SECONDS;

/** A signing-confirmation budget denial, and nothing else: 429, code exactly "rate_limited", retryable exactly true. */
function isConfirmDenial(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 429 && error.code === "rate_limited" && error.retryable === true;
}

/** The three — and only three — requests the server charges to the shared Turnkey reconcile budget. */
const CHARGED_ENDPOINT = /\/backup\/authorize\/reconcile$|\/backup\/verify-signing\/confirm$|\/revoke\/reconcile$/;
const CONFIRM_ENDPOINT = /\/backup\/verify-signing\/confirm$/;

/**
 * 3A-3 Stage 2B: the one signing activity id the last "approve once more" produced, kept so a confirmation that could not be
 * settled can be retried WITHOUT a new signing approval. Memory only; it holds the id and a counter, never the digest, a
 * signature or any secret. It is usable only for the account (appUserId + generation) and enrollment it was made for.
 */
type KeptProof = { enrollmentId: string; activityId: string; appUserId: string | null; generation: number; seq: number; failures: number };
/** HTTP 400s tolerated for ONE proof: the first two keep it, the third discards it (a 400 can be a transient provider read error). */
const KEPT_PROOF_MAX_BAD_REQUESTS = 3;

/** `answer`: the server answered (deferred: it said it did not check). `waiting`: nothing was answered — refused locally, or denied by the confirmation's 429. */
type Charged<T> = { kind: "answer"; data: T; deferred: boolean } | { kind: "waiting" };
type Stop = "deferred" | "waiting" | null;

/** Bounded, spaced reconcile calls — never an unbounded loop, never a resubmission. A deferral or a local refusal ends it at once. */
async function reconcileUntilSettled(
  scope: Scope,
  call: () => Promise<Charged<Outcome>>,
  settled: (o: Outcome) => boolean,
): Promise<{ answer: Outcome | null; stop: Stop }> {
  let answer: Outcome | null = null;
  for (let i = 0; i < RECONCILE_ATTEMPTS; i += 1) {
    if (i > 0) {
      await wait(RECONCILE_DELAY_MS);
      scope.check();
    }
    const result = await call();
    if (result.kind === "waiting") return { answer, stop: "waiting" };
    answer = result.data;
    if (result.deferred) return { answer, stop: "deferred" };
    if (settled(answer)) break;
  }
  return { answer, stop: null };
}

const INITIAL_STATE = {
  passkeys: [],
  enrollment: null,
  listStatus: "idle",
  listError: null,
  setupBusy: false,
  setupMessage: null,
  setupMessageIsWait: false,
  setupError: null,
  removalBusyCredentialId: null,
  removalMessage: null,
  removalError: null,
  renameBusyCredentialId: null,
  renameError: null,
  isTurnkeyCheckWaiting: false,
  turnkeyCheckWaitSeconds: null,
} satisfies Partial<RealPasskeysStore>;

export function createRealPasskeysStore() {
  // Account generation: bumped only by reset() (directly or via
  // bindAccount switching accounts). Every action captures it at start.
  let generation = 0;
  let boundAppUserId: string | null = null;
  // Latest-wins for list loads within one account: an older refresh()
  // resolving after a newer one never overwrites it.
  let refreshSequence = 0;
  // 3A-3: the ONE shared wait for the three charged requests — private, in memory only, bound to the
  // account generation and appUserId it was recorded under. The published flags and the expiry timer
  // below only mirror it; the timer never fetches, signs or invokes an action.
  let turnkeyWait: { generation: number; appUserId: string | null; untilMs: number } | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  // 3A-3 Stage 2B: the retained signing proof (private, in memory, never persisted). proofSeq orders installs so a status read
  // that STARTED before a proof existed can never discard it.
  let keptProof: KeptProof | null = null;
  let proofSeq = 0;

  return create<RealPasskeysStore>()((set, get) => {
    function scope(): Scope {
      const myGeneration = generation;
      const live = () => myGeneration === generation;
      return {
        live,
        check: () => {
          if (!live()) throw new StaleAccountError();
        },
        put: (partial) => {
          // A setup message that does not say it is wait copy is not wait copy.
          if (live()) set("setupMessage" in partial && !("setupMessageIsWait" in partial) ? { ...partial, setupMessageIsWait: false } : partial);
        },
      };
    }

    /** Whole milliseconds left on the current account's wait; 0 when there is none (a record from another account or generation is dead). */
    function remainingWaitMs(): number {
      if (!turnkeyWait) return 0;
      if (turnkeyWait.generation !== generation || turnkeyWait.appUserId !== boundAppUserId) return 0;
      return Math.max(0, turnkeyWait.untilMs - Date.now());
    }
    const remainingWaitSeconds = () => Math.max(1, Math.ceil(remainingWaitMs() / 1000));

    function clearWaitTimer() {
      if (waitTimer !== null) clearTimeout(waitTimer);
      waitTimer = null;
    }

    /** Mirrors the private record into the published flags and (re)arms the one expiry timer. Fetches nothing. */
    function publishWait() {
      clearWaitTimer();
      const remaining = remainingWaitMs();
      if (remaining <= 0) {
        turnkeyWait = null;
        // The wait is over, so its temporary copy goes with it — and only that copy: the stored outcome, a review reason or a
        // pending removal's own message is left exactly as it was. A state write; nothing is fetched, signed or submitted.
        set((state) => ({
          isTurnkeyCheckWaiting: false,
          turnkeyCheckWaitSeconds: null,
          ...(state.setupMessageIsWait ? { setupMessage: null, setupMessageIsWait: false } : {}),
          ...(state.removalMessage?.waitBase !== undefined ? { removalMessage: { credentialId: state.removalMessage.credentialId, text: state.removalMessage.waitBase } } : {}),
        }));
        return;
      }
      set({ isTurnkeyCheckWaiting: true, turnkeyCheckWaitSeconds: Math.ceil(remaining / 1000) });
      const recorded = turnkeyWait!;
      waitTimer = setTimeout(() => {
        // A stale timer (reset, another account, or a later deadline that replaced this one) writes nothing.
        if (recorded.generation !== generation || turnkeyWait !== recorded) return;
        waitTimer = null;
        publishWait();
      }, remaining);
    }

    /** Records a wait for the originating live scope only; never shortens a running one. */
    function recordWait(s: Scope, seconds: number) {
      if (!s.live()) return;
      const until = Date.now() + seconds * 1000;
      const running = remainingWaitMs() > 0 && turnkeyWait ? turnkeyWait.untilMs : 0;
      turnkeyWait = { generation, appUserId: boundAppUserId, untilMs: Math.max(until, running) };
      publishWait();
    }

    /**
     * The one door for the three charged requests. Refuses locally (no fetch) during a wait; otherwise sends,
     * and turns a valid server denial into the shared wait:
     *  - reconcile: HTTP 200 with `reconciliationDeferred` — absent means an ordinary answer; present and
     *    exactly `true` with a whole 1…86 400 `retryAfterSeconds` waits that long; present but anything
     *    else waits the 60 s fallback (never "retry now", never a made-up outcome).
     *  - confirmation: HTTP 429 with code "rate_limited" and retryable true waits the Retry-After header
     *    (strictly parsed, else 60 s). Any other error is an ordinary error and starts no wait.
     * Server data is returned untouched; a stale scope throws before anything is applied or recorded.
     */
    async function chargedPost<T extends Outcome>(s: Scope, url: string, body: unknown): Promise<Charged<T>> {
      if (!CHARGED_ENDPOINT.test(url)) throw new Error("chargedPost is only for the three charged endpoints.");
      s.check();
      if (remainingWaitMs() > 0) return { kind: "waiting" };
      if (turnkeyWait) publishWait(); // the wait has run out (a throttled timer may not have said so yet): settle the published state
      let data: T;
      try {
        data = await post<T>(url, body);
      } catch (error) {
        s.check();
        if (CONFIRM_ENDPOINT.test(url) && isConfirmDenial(error)) {
          recordWait(s, parseTurnkeyRetryAfter(error.retryAfter) ?? TURNKEY_WAIT_FALLBACK_SECONDS);
          return { kind: "waiting" };
        }
        throw error;
      }
      s.check();
      if (CONFIRM_ENDPOINT.test(url) || !("reconciliationDeferred" in data)) return { kind: "answer", data, deferred: false };
      recordWait(s, data.reconciliationDeferred === true && isWholeDelay(data.retryAfterSeconds) ? data.retryAfterSeconds : TURNKEY_WAIT_FALLBACK_SECONDS);
      return { kind: "answer", data, deferred: true };
    }

    /** The kept proof, only if it belongs to this account, this generation and this enrollment. */
    function usableProof(enrollmentId: string): KeptProof | null {
      const proof = keptProof;
      return proof && proof.generation === generation && proof.appUserId === boundAppUserId && proof.enrollmentId === enrollmentId ? proof : null;
    }

    /** Discards `proof` — and only that very record, so a stale caller can never discard a newer one. */
    function dropProof(proof: KeptProof) {
      if (keptProof === proof) keptProof = null;
    }

    /** A current status read discards a proof whose enrollment is gone, different, or no longer awaiting this last step. Reads that began before the proof existed (seenSeq) are ignored. */
    function syncProof(enrollment: BackupEnrollmentStatus | null, seenSeq: number) {
      const proof = keptProof;
      if (!proof || proof.seq > seenSeq) return;
      if (!enrollment || enrollment.id !== proof.enrollmentId || enrollment.state !== "login_verified") dropProof(proof);
    }

    async function fetchStatus(s: Scope): Promise<BackupEnrollmentStatus | null> {
      const seenSeq = proofSeq;
      const { enrollment } = await api<{ enrollment: BackupEnrollmentStatus | null }>("/api/real/account/passkeys/backup/status");
      s.check();
      syncProof(enrollment, seenSeq);
      s.put({ enrollment });
      return enrollment;
    }

    /** Runs exactly one step from the durable state; returns false when setup should stop for now. */
    async function runSetupStep(s: Scope, enrollment: BackupEnrollmentStatus | null): Promise<boolean> {
      const state = enrollment?.state ?? null;
      if (state === null || state === "started") {
        // 2g-H: every registration challenge requires a fresh confirmation by
        // the passkey this browser is signed in with — never the cookie alone.
        s.put({ setupMessage: "Confirm it's you with the passkey you're signed in with…" });
        const stepUpOptions = await post<{ optionsJSON: PublicKeyCredentialRequestOptionsJSON }>("/api/real/account/passkeys/backup/step-up/options");
        s.check();
        const stepUp = await performLoginCeremony(stepUpOptions.optionsJSON);
        s.check();
        s.put({ setupMessage: "Create your new backup passkey…" });
        const { optionsJSON } = await post<{ optionsJSON: PublicKeyCredentialCreationOptionsJSON }>("/api/real/account/passkeys/backup/options", { stepUp });
        s.check();
        const response = await performRegistrationCeremony(optionsJSON);
        s.check();
        await post("/api/real/account/passkeys/backup/register", { response });
        return true;
      }
      const enrollmentId = enrollment!.id;
      if (state === "credential_registered" && enrollment!.externalOutcome !== "not_attempted") {
        // 2g-H: a create was already sent (a legacy "declined" one included) — only a read-only re-check, never a new authorization.
        s.put({ setupMessage: "Checking whether your backup setup went through…" });
        return handleChargedCreate(s, await chargedPost<Outcome>(s, "/api/real/account/passkeys/backup/authorize/reconcile", { enrollmentId }), enrollment!);
      }
      if (state === "credential_registered") {
        s.put({ setupMessage: "Approve with the passkey you're signed in with…" });
        const prepared = await post<{ activity: CreateAuthenticatorsActivity; rpId: string; authorizingCredentialId: string }>("/api/real/account/passkeys/backup/authorize/options", { enrollmentId });
        s.check();
        const signedRequest = await stampCreateAuthenticatorsRequest(prepared);
        s.check();
        const result = await post<Outcome>("/api/real/account/passkeys/backup/authorize/submit", { enrollmentId, signedRequest });
        return handleCreateOutcome(s, result);
      }
      if (state === "blocked") {
        // Review: one read-only re-check (server-side discovery). Never a new authorization.
        s.put({ setupMessage: "Checking whether your backup setup went through…" });
        return handleChargedCreate(s, await chargedPost<Outcome>(s, "/api/real/account/passkeys/backup/authorize/reconcile", { enrollmentId }), enrollment!);
      }
      if (state === "turnkey_enrollment_in_flight") {
        s.put({ setupMessage: "Confirming your authorization…" });
        const result = await reconcileUntilSettled(
          s,
          () => chargedPost<Outcome>(s, "/api/real/account/passkeys/backup/authorize/reconcile", { enrollmentId }),
          (o) => o.outcome !== "pending",
        );
        return handleCreateOutcome(s, result.answer, result.stop);
      }
      if (state === "turnkey_authenticator_created") {
        s.put({ setupMessage: "Sign in once with your new backup passkey…" });
        const { optionsJSON } = await post<{ optionsJSON: PublicKeyCredentialRequestOptionsJSON }>("/api/real/account/passkeys/backup/verify-login/options", { enrollmentId });
        s.check();
        const response = await performLoginCeremony(optionsJSON);
        s.check();
        await post("/api/real/account/passkeys/backup/verify-login/confirm", { response });
        return true;
      }
      if (state === "login_verified") {
        let proof = usableProof(enrollmentId);
        if (!proof) {
          // 3A-3: no new signing ceremony while the confirmation that would follow it is refused.
          if (remainingWaitMs() > 0) {
            s.put({ setupMessage: signingCheckWaitMessage(remainingWaitSeconds()), setupMessageIsWait: true });
            return false;
          }
          s.put({ setupMessage: "Approve once more with your new backup passkey…" });
          const options = await post<{ subOrganizationId: string; ownerAddress: string; rpId: string; authorizingCredentialId: string; digest: `0x${string}` }>(
            "/api/real/account/passkeys/backup/verify-signing/options",
            { enrollmentId },
          );
          s.check();
          const { activityId } = await signDigestViaTurnkeyRaw(options);
          s.check();
          // Keep the activity id BEFORE asking the server to confirm it: whatever the confirmation does (a wait, an
          // error, a lost connection), the approval that produced this id is not thrown away.
          proof = { enrollmentId, activityId, appUserId: boundAppUserId, generation, seq: ++proofSeq, failures: 0 };
          keptProof = proof;
        }
        let confirmed: Charged<Outcome>;
        try {
          // Through the same charged door as ever: during a wait this sends nothing and the proof stays.
          confirmed = await chargedPost<Outcome>(s, "/api/real/account/passkeys/backup/verify-signing/confirm", { enrollmentId, activityId: proof.activityId });
        } catch (error) {
          // Only a live scope's own HTTP 400 counts, by status alone; a stale response, a network failure, a 429/500/503 never does.
          if (error instanceof ApiError && error.status === 400 && s.live() && keptProof === proof) {
            proof.failures += 1;
            if (proof.failures >= KEPT_PROOF_MAX_BAD_REQUESTS) dropProof(proof);
          }
          throw error;
        }
        if (confirmed.kind === "waiting") {
          s.put({ setupMessage: signingCheckWaitMessage(remainingWaitSeconds()), setupMessageIsWait: true });
          return false;
        }
        dropProof(proof);
        return true;
      }
      return false;
    }

    /** A single charged create-reconcile call: a local refusal or a deferral stops here; otherwise it is an ordinary outcome. */
    function handleChargedCreate(s: Scope, charged: Charged<Outcome>, enrollment: BackupEnrollmentStatus): boolean {
      if (charged.kind === "waiting") {
        // Refused locally, so there is no new answer — but the status just read still holds the stored one. A setup under
        // review keeps its stored review reason (never a made-up one, never an "unconfirmed" replacement).
        const stored: Outcome | null = enrollment.state === "blocked" ? { outcome: "blocked", reason: enrollment.blockReason ?? undefined } : null;
        return handleCreateOutcome(s, stored, "waiting");
      }
      return handleCreateOutcome(s, charged.data, charged.deferred ? "deferred" : null);
    }

    function handleCreateOutcome(s: Scope, result: Outcome | null, stop: Stop = null): boolean {
      s.check();
      if (stop !== null) {
        // The check did not run (or was deferred): report the stored state exactly as the server gave it,
        // add when a manual check is possible, and claim nothing about the outcome.
        const seconds = remainingWaitSeconds();
        if (result?.outcome === "blocked") {
          s.put({ setupError: result.reason ?? "This setup needs manual review.", setupMessage: reviewCheckWaitMessage(seconds), setupMessageIsWait: true });
        } else {
          s.put({ setupMessage: backupCheckWaitMessage(seconds), setupMessageIsWait: true });
        }
        return false;
      }
      if (result === null) return false;
      if (result.outcome === "confirmed") return true;
      if (result.outcome === "blocked") {
        s.put({ setupError: result.reason ?? "This setup needs manual review." });
        return false;
      }
      s.put({ setupMessage: result.reason ?? "Your authorization was sent but isn't confirmed yet. Check again shortly." });
      return false;
    }

    async function reconcileRemoval(s: Scope, credentialId: string, attemptId: string, submittedReason?: string) {
      const result = await reconcileUntilSettled(
        s,
        () => chargedPost<Outcome>(s, `/api/real/account/passkeys/${encodeURIComponent(credentialId)}/revoke/reconcile`, { attemptId }),
        (o) => o.outcome !== "pending",
      );
      if (result.stop !== null) {
        // Deferred or refused: the removal is exactly as pending as the server last said — never confirmed, never failed.
        const reason = result.answer?.reason ?? submittedReason;
        s.put({ removalMessage: { credentialId, text: removalCheckWaitMessage(reason, remainingWaitSeconds()), waitBase: removalCheckWaitBase(reason) } });
        return;
      }
      if (result.answer) showRemovalOutcome(s, credentialId, result.answer);
    }

    /** A confirmed removal's row disappears from the list, so it gets its own message. */
    function showRemovalOutcome(s: Scope, credentialId: string, result: Outcome) {
      if (result.outcome === "revoked") s.put({ removalMessage: { credentialId, text: PASSKEY_REMOVED_MESSAGE } });
      else if (result.reason) s.put({ removalMessage: { credentialId, text: result.reason } });
    }

    /** Shared tail of every action: clear its busy flag and reload the list — only if its account is still the current one. */
    async function finish(s: Scope, partial: Partial<RealPasskeysStore>) {
      if (!s.live()) return;
      set(partial);
      await get().refresh();
    }

    return {
      ...INITIAL_STATE,

      refresh: async () => {
        const s = scope();
        const mySequence = ++refreshSequence;
        const current = () => s.live() && mySequence === refreshSequence;
        const seenSeq = proofSeq;
        set({ listStatus: "loading", listError: null });
        try {
          const [list, status] = await Promise.all([
            api<{ passkeys: RealPasskeySummary[] }>("/api/real/account/passkeys"),
            api<{ enrollment: BackupEnrollmentStatus | null }>("/api/real/account/passkeys/backup/status"),
          ]);
          if (current()) {
            syncProof(status.enrollment, seenSeq);
            set({ passkeys: list.passkeys, enrollment: status.enrollment, listStatus: "ready" });
          }
        } catch (error) {
          if (current()) set({ listStatus: "error", listError: error instanceof Error ? error.message : "Could not load passkeys." });
        }
      },

      continueBackupSetup: async () => {
        // One setup action at a time: an overlapping Resume would ask for a second signing challenge and invalidate the first's.
        if (get().setupBusy) return;
        const s = scope();
        set({ setupBusy: true, setupError: null, setupMessage: null });
        try {
          for (let step = 0; step < MAX_SETUP_STEPS; step += 1) {
            const enrollment = await fetchStatus(s);
            if (step > 0 && !enrollment) break; // reached a terminal state (active)
            if (!(await runSetupStep(s, enrollment))) break;
            s.check();
          }
        } catch (error) {
          if (!(error instanceof StaleAccountError) && !isWebAuthnCancellation(error)) {
            s.put({ setupError: error instanceof Error ? error.message : "Backup passkey setup couldn't continue." });
          }
        } finally {
          await finish(s, { setupBusy: false });
        }
      },

      abandonBackupSetup: async () => {
        const enrollment = get().enrollment;
        if (!enrollment) return;
        const s = scope();
        set({ setupBusy: true, setupError: null });
        try {
          await post("/api/real/account/passkeys/backup/abandon", { enrollmentId: enrollment.id });
          const proof = usableProof(enrollment.id);
          if (proof) dropProof(proof);
          s.put({ setupMessage: null });
        } catch (error) {
          s.put({ setupError: error instanceof Error ? error.message : "Couldn't cancel setup." });
        } finally {
          await finish(s, { setupBusy: false });
        }
      },

      removePasskey: async (credentialId) => {
        const s = scope();
        set({ removalBusyCredentialId: credentialId, removalError: null, removalMessage: null });
        try {
          const path = `/api/real/account/passkeys/${encodeURIComponent(credentialId)}/revoke`;
          const prepared = await post<{ attemptId: string; activity: DeleteAuthenticatorsActivity; rpId: string; authorizingCredentialId: string }>(`${path}/options`);
          s.check();
          // The target is still fully active here; only a verified submit disables it.
          const signedRequest = await stampDeleteAuthenticatorsRequest(prepared);
          s.check();
          const submitted = await post<Outcome>(`${path}/submit`, { attemptId: prepared.attemptId, signedRequest });
          s.check();
          if (submitted.outcome === "pending") await reconcileRemoval(s, credentialId, prepared.attemptId, submitted.reason);
          else showRemovalOutcome(s, credentialId, submitted);
        } catch (error) {
          if (!(error instanceof StaleAccountError) && !isWebAuthnCancellation(error)) {
            s.put({ removalError: error instanceof Error ? error.message : "Couldn't remove this passkey." });
          }
        } finally {
          await finish(s, { removalBusyCredentialId: null });
        }
      },

      checkRemoval: async (credentialId, attemptId) => {
        const s = scope();
        set({ removalBusyCredentialId: credentialId, removalError: null });
        try {
          await reconcileRemoval(s, credentialId, attemptId);
        } catch (error) {
          if (!(error instanceof StaleAccountError)) s.put({ removalError: error instanceof Error ? error.message : "Couldn't check this removal." });
        } finally {
          await finish(s, { removalBusyCredentialId: null });
        }
      },

      cancelRemoval: async (credentialId, attemptId) => {
        const s = scope();
        set({ removalBusyCredentialId: credentialId, removalError: null });
        try {
          await post(`/api/real/account/passkeys/${encodeURIComponent(credentialId)}/revoke/cancel`, { attemptId });
          s.put({ removalMessage: null });
        } catch (error) {
          s.put({ removalError: error instanceof Error ? error.message : "Couldn't cancel this removal." });
        } finally {
          await finish(s, { removalBusyCredentialId: null });
        }
      },

      renamePasskey: async (credentialId, displayName) => {
        const validation = validatePasskeyDisplayName(displayName);
        if (!validation.ok) {
          set({ renameError: { credentialId, text: validation.reason } });
          return false;
        }
        const s = scope();
        set({ renameBusyCredentialId: credentialId, renameError: null });
        try {
          await api(`/api/real/account/passkeys/${encodeURIComponent(credentialId)}`, { method: "PATCH", body: JSON.stringify({ displayName: validation.name }) });
          if (!s.live()) return false;
          await get().refresh();
          return true;
        } catch (error) {
          s.put({ renameError: { credentialId, text: error instanceof Error ? error.message : "Couldn't rename this passkey." } });
          return false;
        } finally {
          s.put({ renameBusyCredentialId: null });
        }
      },

      clearRenameError: () => set({ renameError: null }),

      bindAccount: (appUserId) => {
        if (appUserId === boundAppUserId) return;
        get().reset();
        boundAppUserId = appUserId;
      },

      reset: () => {
        generation += 1;
        boundAppUserId = null;
        turnkeyWait = null;
        clearWaitTimer();
        keptProof = null;
        set({ ...INITIAL_STATE });
      },
    };
  });
}

export const useRealPasskeysStore = createRealPasskeysStore();
