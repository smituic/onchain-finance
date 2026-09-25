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
import type { PasskeyRole, PasskeyStatus, RemovalAttemptState } from "@/lib/real/display/passkey-status";

/**
 * Client orchestration of backup-passkey setup and passkey removal. The
 * DURABLE server state is always the source of truth: every action first
 * reads it (/backup/status, the passkey list) and resumes from wherever it
 * actually is — never from anything this store remembered. The browser
 * only ever STAMPS Turnkey mutations (authenticator-requests.ts); the server
 * validates, records, and forwards them. No persist middleware, no
 * localStorage.
 */
export type RealPasskeySummary = {
  credentialId: string;
  role: PasskeyRole;
  status: PasskeyStatus;
  credentialDeviceType: "singleDevice" | "multiDevice" | null;
  credentialBackedUp: boolean | null;
  createdAt: string;
  isCurrentSession: boolean;
  canAuthorizeRemovals: boolean;
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
  | "blocked";

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

  refresh: () => Promise<void>;
  continueBackupSetup: () => Promise<void>;
  abandonBackupSetup: () => Promise<void>;
  removePasskey: (credentialId: string) => Promise<void>;
  checkRemoval: (credentialId: string, attemptId: string) => Promise<void>;
  cancelRemoval: (credentialId: string, attemptId: string) => Promise<void>;
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

/** Bounded, spaced reconcile calls — never an unbounded loop, never a resubmission. */
async function reconcileUntilSettled(call: () => Promise<Outcome>, settled: (o: Outcome) => boolean): Promise<Outcome> {
  let last = await call();
  for (let i = 1; i < RECONCILE_ATTEMPTS && !settled(last); i += 1) {
    await wait(RECONCILE_DELAY_MS);
    last = await call();
  }
  return last;
}

export function createRealPasskeysStore() {
  return create<RealPasskeysStore>()((set, get) => {
    async function fetchStatus(): Promise<BackupEnrollmentStatus | null> {
      const { enrollment } = await api<{ enrollment: BackupEnrollmentStatus | null }>("/api/real/account/passkeys/backup/status");
      set({ enrollment });
      return enrollment;
    }

    /** Runs exactly one step from the durable state; returns false when setup should stop for now. */
    async function runSetupStep(enrollment: BackupEnrollmentStatus | null): Promise<boolean> {
      const state = enrollment?.state ?? null;
      if (state === null || state === "started") {
        set({ setupMessage: "Create your new backup passkey…" });
        const { optionsJSON } = await post<{ optionsJSON: PublicKeyCredentialCreationOptionsJSON }>("/api/real/account/passkeys/backup/options");
        const response = await performRegistrationCeremony(optionsJSON);
        await post("/api/real/account/passkeys/backup/register", { response });
        return true;
      }
      const enrollmentId = enrollment!.id;
      if (state === "credential_registered") {
        set({ setupMessage: "Approve with the passkey you're signed in with…" });
        const prepared = await post<{ activity: CreateAuthenticatorsActivity; rpId: string; authorizingCredentialId: string }>("/api/real/account/passkeys/backup/authorize/options", { enrollmentId });
        const signedRequest = await stampCreateAuthenticatorsRequest(prepared);
        const result = await post<Outcome>("/api/real/account/passkeys/backup/authorize/submit", { enrollmentId, signedRequest });
        return handleCreateOutcome(result);
      }
      if (state === "turnkey_enrollment_in_flight") {
        set({ setupMessage: "Confirming your authorization…" });
        const result = await reconcileUntilSettled(
          () => post<Outcome>("/api/real/account/passkeys/backup/authorize/reconcile", { enrollmentId }),
          (o) => o.outcome !== "pending",
        );
        return handleCreateOutcome(result);
      }
      if (state === "turnkey_authenticator_created") {
        set({ setupMessage: "Sign in once with your new backup passkey…" });
        const { optionsJSON } = await post<{ optionsJSON: PublicKeyCredentialRequestOptionsJSON }>("/api/real/account/passkeys/backup/verify-login/options", { enrollmentId });
        const response = await performLoginCeremony(optionsJSON);
        await post("/api/real/account/passkeys/backup/verify-login/confirm", { response });
        return true;
      }
      if (state === "login_verified") {
        set({ setupMessage: "Approve once more with your new backup passkey…" });
        const proof = await post<{ subOrganizationId: string; ownerAddress: string; rpId: string; authorizingCredentialId: string; digest: `0x${string}` }>(
          "/api/real/account/passkeys/backup/verify-signing/options",
          { enrollmentId },
        );
        const { activityId } = await signDigestViaTurnkeyRaw(proof);
        await post("/api/real/account/passkeys/backup/verify-signing/confirm", { enrollmentId, activityId });
        return true;
      }
      return false;
    }

    function handleCreateOutcome(result: Outcome): boolean {
      if (result.outcome === "confirmed") return true;
      if (result.outcome === "failed_retryable") {
        set({ setupMessage: result.reason ?? "The authorization was declined. You can try again or cancel setup." });
        return false;
      }
      if (result.outcome === "blocked") {
        set({ setupError: result.reason ?? "This setup needs manual review." });
        return false;
      }
      set({ setupMessage: result.reason ?? "Your authorization was sent but isn't confirmed yet. Check again shortly." });
      return false;
    }

    async function reconcileRemoval(credentialId: string, attemptId: string) {
      const result = await reconcileUntilSettled(
        () => post<Outcome>(`/api/real/account/passkeys/${encodeURIComponent(credentialId)}/revoke/reconcile`, { attemptId }),
        (o) => o.outcome !== "pending",
      );
      if (result.outcome !== "revoked" && result.reason) set({ removalMessage: { credentialId, text: result.reason } });
    }

    return {
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

      refresh: async () => {
        set({ listStatus: "loading", listError: null });
        try {
          const [list] = await Promise.all([api<{ passkeys: RealPasskeySummary[] }>("/api/real/account/passkeys"), fetchStatus()]);
          set({ passkeys: list.passkeys, listStatus: "ready" });
        } catch (error) {
          set({ listStatus: "error", listError: error instanceof Error ? error.message : "Could not load passkeys." });
        }
      },

      continueBackupSetup: async () => {
        set({ setupBusy: true, setupError: null, setupMessage: null });
        try {
          for (let step = 0; step < MAX_SETUP_STEPS; step += 1) {
            const enrollment = await fetchStatus();
            if (step > 0 && !enrollment) break; // reached a terminal state (active)
            if (!(await runSetupStep(enrollment))) break;
          }
        } catch (error) {
          if (!isWebAuthnCancellation(error)) set({ setupError: error instanceof Error ? error.message : "Backup passkey setup couldn't continue." });
        } finally {
          set({ setupBusy: false });
          await get().refresh();
        }
      },

      abandonBackupSetup: async () => {
        const enrollment = get().enrollment;
        if (!enrollment) return;
        set({ setupBusy: true, setupError: null });
        try {
          await post("/api/real/account/passkeys/backup/abandon", { enrollmentId: enrollment.id });
          set({ setupMessage: null });
        } catch (error) {
          set({ setupError: error instanceof Error ? error.message : "Couldn't cancel setup." });
        } finally {
          set({ setupBusy: false });
          await get().refresh();
        }
      },

      removePasskey: async (credentialId) => {
        set({ removalBusyCredentialId: credentialId, removalError: null, removalMessage: null });
        try {
          const path = `/api/real/account/passkeys/${encodeURIComponent(credentialId)}/revoke`;
          const prepared = await post<{ attemptId: string; activity: DeleteAuthenticatorsActivity; rpId: string; authorizingCredentialId: string }>(`${path}/options`);
          // The target is still fully active here; only a verified submit disables it.
          const signedRequest = await stampDeleteAuthenticatorsRequest(prepared);
          const submitted = await post<Outcome>(`${path}/submit`, { attemptId: prepared.attemptId, signedRequest });
          if (submitted.outcome === "pending") await reconcileRemoval(credentialId, prepared.attemptId);
          else if (submitted.outcome !== "revoked" && submitted.reason) set({ removalMessage: { credentialId, text: submitted.reason } });
        } catch (error) {
          if (!isWebAuthnCancellation(error)) set({ removalError: error instanceof Error ? error.message : "Couldn't remove this passkey." });
        } finally {
          set({ removalBusyCredentialId: null });
          await get().refresh();
        }
      },

      checkRemoval: async (credentialId, attemptId) => {
        set({ removalBusyCredentialId: credentialId, removalError: null });
        try {
          await reconcileRemoval(credentialId, attemptId);
        } catch (error) {
          set({ removalError: error instanceof Error ? error.message : "Couldn't check this removal." });
        } finally {
          set({ removalBusyCredentialId: null });
          await get().refresh();
        }
      },

      cancelRemoval: async (credentialId, attemptId) => {
        set({ removalBusyCredentialId: credentialId, removalError: null });
        try {
          await post(`/api/real/account/passkeys/${encodeURIComponent(credentialId)}/revoke/cancel`, { attemptId });
          set({ removalMessage: null });
        } catch (error) {
          set({ removalError: error instanceof Error ? error.message : "Couldn't cancel this removal." });
        } finally {
          set({ removalBusyCredentialId: null });
          await get().refresh();
        }
      },
    };
  });
}

export const useRealPasskeysStore = createRealPasskeysStore();
