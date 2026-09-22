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
  logout: () => Promise<void>;
};

export const REAL_ACCOUNT_STORE_NAME = "onchain-finance:real-account";

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
  const store = create<RealAccountStore>()(
    persist(
      (set) => ({
        account: null,
        status: "idle",
        error: null,
        hasHydrated: false,

        checkSession: async () => {
          set({ status: "checking-session", error: null });
          try {
            const result = await api<SessionResponse>("/api/real/session");
            if (result.authenticated && result.appUserId && result.ownerAddress && result.safeAddress) {
              set({
                account: { appUserId: result.appUserId, ownerAddress: result.ownerAddress, safeAddress: result.safeAddress },
                status: "ready",
              });
            } else {
              set({ account: null, status: "signed-out" });
            }
          } catch (error) {
            set({ status: "error", error: error instanceof Error ? error.message : "Could not check session." });
          }
        },

        register: async () => {
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
            set({ account, status: "ready" });
          } catch (error) {
            if (isWebAuthnCancellation(error)) {
              set({ status: "signed-out", error: null });
              return;
            }
            set({ status: "error", error: error instanceof Error ? error.message : "Registration failed." });
          }
        },

        login: async () => {
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
            set({ account, status: "ready" });
          } catch (error) {
            if (isWebAuthnCancellation(error)) {
              set({ status: "signed-out", error: null });
              return;
            }
            set({ status: "error", error: error instanceof Error ? error.message : "Login failed." });
          }
        },

        logout: async () => {
          try {
            await api("/api/real/session", { method: "DELETE" });
          } finally {
            set({ account: null, status: "signed-out", error: null });
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
