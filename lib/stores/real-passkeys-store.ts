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
import { PASSKEY_REMOVED_MESSAGE, type PasskeyRole, type PasskeyStatus, type RemovalAttemptState } from "@/lib/real/display/passkey-status";
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
  setupError: string | null;
  removalBusyCredentialId: string | null;
  removalMessage: { credentialId: string; text: string } | null;
  removalError: string | null;
  renameBusyCredentialId: string | null;
  renameError: { credentialId: string; text: string } | null;

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

type Outcome = { outcome: string; reason?: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `Request failed (${response.status})`);
  return json;
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

/** Bounded, spaced reconcile calls — never an unbounded loop, never a resubmission. */
async function reconcileUntilSettled(scope: Scope, call: () => Promise<Outcome>, settled: (o: Outcome) => boolean): Promise<Outcome> {
  let last = await call();
  for (let i = 1; i < RECONCILE_ATTEMPTS && !settled(last); i += 1) {
    await wait(RECONCILE_DELAY_MS);
    scope.check();
    last = await call();
  }
  return last;
}

const INITIAL_STATE = {
  passkeys: [],
  enrollment: null,
  listStatus: "idle",
  listError: null,
  setupBusy: false,
  setupMessage: null,
  setupError: null,
  removalBusyCredentialId: null,
  removalMessage: null,
  removalError: null,
  renameBusyCredentialId: null,
  renameError: null,
} satisfies Partial<RealPasskeysStore>;

export function createRealPasskeysStore() {
  // Account generation: bumped only by reset() (directly or via
  // bindAccount switching accounts). Every action captures it at start.
  let generation = 0;
  let boundAppUserId: string | null = null;
  // Latest-wins for list loads within one account: an older refresh()
  // resolving after a newer one never overwrites it.
  let refreshSequence = 0;

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
          if (live()) set(partial);
        },
      };
    }

    async function fetchStatus(s: Scope): Promise<BackupEnrollmentStatus | null> {
      const { enrollment } = await api<{ enrollment: BackupEnrollmentStatus | null }>("/api/real/account/passkeys/backup/status");
      s.check();
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
        return handleCreateOutcome(s, await post<Outcome>("/api/real/account/passkeys/backup/authorize/reconcile", { enrollmentId }));
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
        return handleCreateOutcome(s, await post<Outcome>("/api/real/account/passkeys/backup/authorize/reconcile", { enrollmentId }));
      }
      if (state === "turnkey_enrollment_in_flight") {
        s.put({ setupMessage: "Confirming your authorization…" });
        const result = await reconcileUntilSettled(
          s,
          () => post<Outcome>("/api/real/account/passkeys/backup/authorize/reconcile", { enrollmentId }),
          (o) => o.outcome !== "pending",
        );
        return handleCreateOutcome(s, result);
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
        s.put({ setupMessage: "Approve once more with your new backup passkey…" });
        const proof = await post<{ subOrganizationId: string; ownerAddress: string; rpId: string; authorizingCredentialId: string; digest: `0x${string}` }>(
          "/api/real/account/passkeys/backup/verify-signing/options",
          { enrollmentId },
        );
        s.check();
        const { activityId } = await signDigestViaTurnkeyRaw(proof);
        s.check();
        await post("/api/real/account/passkeys/backup/verify-signing/confirm", { enrollmentId, activityId });
        return true;
      }
      return false;
    }

    function handleCreateOutcome(s: Scope, result: Outcome): boolean {
      s.check();
      if (result.outcome === "confirmed") return true;
      if (result.outcome === "blocked") {
        s.put({ setupError: result.reason ?? "This setup needs manual review." });
        return false;
      }
      s.put({ setupMessage: result.reason ?? "Your authorization was sent but isn't confirmed yet. Check again shortly." });
      return false;
    }

    async function reconcileRemoval(s: Scope, credentialId: string, attemptId: string) {
      const result = await reconcileUntilSettled(
        s,
        () => post<Outcome>(`/api/real/account/passkeys/${encodeURIComponent(credentialId)}/revoke/reconcile`, { attemptId }),
        (o) => o.outcome !== "pending",
      );
      showRemovalOutcome(s, credentialId, result);
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
        set({ listStatus: "loading", listError: null });
        try {
          const [list, status] = await Promise.all([
            api<{ passkeys: RealPasskeySummary[] }>("/api/real/account/passkeys"),
            api<{ enrollment: BackupEnrollmentStatus | null }>("/api/real/account/passkeys/backup/status"),
          ]);
          if (current()) set({ passkeys: list.passkeys, enrollment: status.enrollment, listStatus: "ready" });
        } catch (error) {
          if (current()) set({ listStatus: "error", listError: error instanceof Error ? error.message : "Could not load passkeys." });
        }
      },

      continueBackupSetup: async () => {
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
          if (submitted.outcome === "pending") await reconcileRemoval(s, credentialId, prepared.attemptId);
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
        set({ ...INITIAL_STATE });
      },
    };
  });
}

export const useRealPasskeysStore = createRealPasskeysStore();
