import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { isWebAuthnCancellation, performLoginCeremony, performRegistrationCeremony } from "@/lib/real/account/webauthn-client";

/**
 * PUBLIC account metadata only — never signing material, never a Turnkey
 * client, never anything that authorizes a signature. This store's job is
 * app identity/session orchestration (register, restore/login, logout) and
 * caching what's safe to show immediately on reload; every real payment
 * still builds its own fresh signing account via
 * lib/real/signing/verified-account.ts at the moment it's needed, never
 * from anything cached here.
 */
export type RealAccountPublicState = {
  appUserId: string;
  ownerAddress: string;
  safeAddress: string;
};

export type RealAccountStatus =
  | "idle"
  | "checking-session"
  | "registering"
  | "logging-in"
  | "signing-out"
  | "ready"
  | "signed-out"
  | "error";

export type RealAccountStore = {
  account: RealAccountPublicState | null;
  status: RealAccountStatus;
  error: string | null;
  hasHydrated: boolean;
  /** Re-verifies the current HttpOnly session against the server — the cached `account` above is a convenience for instant paint, never trusted on its own for anything sensitive. */
  checkSession: () => Promise<void>;
  register: () => Promise<void>;
  login: () => Promise<void>;
  /**
   * "Sign out everywhere" (S4): ends every session for this account, on every
   * device. Local state flips to signed-out only once the server confirms;
   * on failure the account stays shown, with an error.
   */
  logout: () => Promise<void>;
};

export const REAL_ACCOUNT_STORE_NAME = "onchain-finance:real-account";

export const SIGN_OUT_EVERYWHERE_FAILED_MESSAGE = "Couldn't sign out everywhere, so you're still signed in. Try again.";
export const ALREADY_SIGNED_OUT_MESSAGE =
  "This device was already signed out, so your other devices weren't signed out from here. To sign them out, sign in again and choose Sign out everywhere.";

type PersistedRealAccountState = { account: RealAccountPublicState | null };

type SessionResponse = {
  authenticated: boolean;
  appUserId?: string;
  ownerAddress?: string;
  safeAddress?: string;
};

type AccountResponse = { appUserId: string; ownerAddress: string; safeAddress: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `Request failed (${response.status})`);
  return json;
}

export function createRealAccountStore() {
  // S4: same generation-token guard as the balance/history/payment stores.
  // Every session transition (check, register, login, sign-out) takes a new
  // generation; a response that lands after a newer transition started is
  // dropped, so a slow answer about one account can never overwrite the
  // state of the account (or signed-out state) that replaced it.
  let generation = 0;

  const store = create<RealAccountStore>()(
    persist(
      (set, get) => ({
        account: null,
        status: "idle",
        error: null,
        hasHydrated: false,

        checkSession: async () => {
          const myGeneration = ++generation;
          set({ status: "checking-session", error: null });
          try {
            const result = await api<SessionResponse>("/api/real/session");
            if (myGeneration !== generation) return;
            if (result.authenticated && result.appUserId && result.ownerAddress && result.safeAddress) {
              set({
                account: { appUserId: result.appUserId, ownerAddress: result.ownerAddress, safeAddress: result.safeAddress },
                status: "ready",
              });
            } else {
              set({ account: null, status: "signed-out" });
            }
          } catch (error) {
            if (myGeneration !== generation) return;
            set({ status: "error", error: error instanceof Error ? error.message : "Could not check session." });
          }
        },

        register: async () => {
          const myGeneration = ++generation;
          set({ status: "registering", error: null });
          try {
            const { optionsJSON } = await api<{ optionsJSON: PublicKeyCredentialCreationOptionsJSON }>(
              "/api/real/account/register/options",
              { method: "POST" },
            );
            const response = await performRegistrationCeremony(optionsJSON);
            const account = await api<AccountResponse>("/api/real/account/register/verify", {
              method: "POST",
              body: JSON.stringify({ response }),
            });
            if (myGeneration !== generation) return;
            set({ account, status: "ready" });
          } catch (error) {
            if (myGeneration !== generation) return;
            if (isWebAuthnCancellation(error)) {
              set({ status: "signed-out", error: null });
              return;
            }
            set({ status: "error", error: error instanceof Error ? error.message : "Registration failed." });
          }
        },

        login: async () => {
          const myGeneration = ++generation;
          set({ status: "logging-in", error: null });
          try {
            const { optionsJSON } = await api<{ optionsJSON: PublicKeyCredentialRequestOptionsJSON }>(
              "/api/real/account/login/options",
              { method: "POST" },
            );
            const response = await performLoginCeremony(optionsJSON);
            const account = await api<AccountResponse>("/api/real/account/login/verify", {
              method: "POST",
              body: JSON.stringify({ response }),
            });
            if (myGeneration !== generation) return;
            set({ account, status: "ready" });
          } catch (error) {
            if (myGeneration !== generation) return;
            if (isWebAuthnCancellation(error)) {
              set({ status: "signed-out", error: null });
              return;
            }
            set({ status: "error", error: error instanceof Error ? error.message : "Login failed." });
          }
        },

        logout: async () => {
          const myGeneration = ++generation;
          const previousStatus = get().status;
          set({ status: "signing-out", error: null });
          let response: Response;
          try {
            response = await fetch("/api/real/session", { method: "DELETE" });
          } catch {
            if (myGeneration === generation) set({ status: previousStatus, error: SIGN_OUT_EVERYWHERE_FAILED_MESSAGE });
            return;
          }
          if (myGeneration !== generation) return;
          if (response.ok) {
            set({ account: null, status: "signed-out", error: null });
          } else if (response.status === 401) {
            // This browser's session was already invalid, so nothing could be
            // revoked from here — signed out locally, and told so honestly.
            set({ account: null, status: "signed-out", error: ALREADY_SIGNED_OUT_MESSAGE });
          } else {
            set({ status: previousStatus, error: SIGN_OUT_EVERYWHERE_FAILED_MESSAGE });
          }
        },
      }),
      {
        name: REAL_ACCOUNT_STORE_NAME,
        storage: createJSONStorage(() => localStorage),
        partialize: (store): PersistedRealAccountState => ({ account: store.account }),
        // Same reasoning as mode-store.ts / simulation-store.ts: no
        // localStorage during server-first rendering, so the presentation
        // layer rehydrates explicitly after mount.
        skipHydration: true,
        version: 0,
      },
    ),
  );

  store.persist.onFinishHydration(() => {
    store.setState({ hasHydrated: true });
  });

  return store;
}

export const useRealAccountStore = createRealAccountStore();

export function useHasRealAccountHydrated(): boolean {
  return useRealAccountStore((s) => s.hasHydrated);
}
