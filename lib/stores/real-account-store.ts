import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { isWebAuthnCancellation, performLoginCeremony, performRegistrationCeremony, signalAccountLabel } from "@/lib/real/account/webauthn-client";
import { validateAccountDisplayName } from "@/lib/real/display/account-name";
import { canonicalizeHandle } from "@/lib/real/handle";

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
  /** The account's permanent @handle, canonical (no "@"). Null/absent until claimed — the account is fully usable without one. */
  handle?: string | null;
  /** Presentation only. Null/absent when none is set. */
  displayName?: string | null;
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
  /** True while a handle claim or display-name save is in flight. Separate from `status`, which gates the whole account UI. */
  profileBusy: boolean;
  profileError: string | null;
  clearProfileError: () => void;
  /**
   * Claims a permanent @handle: server check, then a fresh passkey
   * confirmation by the signed-in passkey, then the claim. Resolves true only
   * once the server confirmed it. Dismissing the passkey prompt is not an error.
   */
  claimHandle: (handle: string) => Promise<boolean>;
  /** Sets (or, with an empty value, clears) the display name. Resolves true once saved. */
  saveDisplayName: (displayName: string) => Promise<boolean>;
};

export const REAL_ACCOUNT_STORE_NAME = "onchain-finance:real-account";

export const SIGN_OUT_EVERYWHERE_FAILED_MESSAGE = "Couldn't sign out everywhere, so you're still signed in. Try again.";
export const ALREADY_SIGNED_OUT_MESSAGE =
  "This device was already signed out, so your other devices weren't signed out from here. To sign them out, sign in again and choose Sign out everywhere.";

type PersistedRealAccountState = { account: RealAccountPublicState | null };

type ProfileResponse = { handle?: string | null; displayName?: string | null };

type SessionResponse = ProfileResponse & {
  authenticated: boolean;
  appUserId?: string;
  ownerAddress?: string;
  safeAddress?: string;
};

type AccountResponse = ProfileResponse & { appUserId: string; ownerAddress: string; safeAddress: string };

/** An account with no handle / display name keeps exactly the shape it always had (the keys are simply absent). */
function toAccount(response: AccountResponse): RealAccountPublicState {
  return {
    appUserId: response.appUserId,
    ownerAddress: response.ownerAddress,
    safeAddress: response.safeAddress,
    ...(response.handle ? { handle: response.handle } : {}),
    ...(response.displayName ? { displayName: response.displayName } : {}),
  };
}

/** Like api(), but keeps the server's refusal body: a 409 from the handle routes may carry the handle the account already owns. */
async function profileApi(url: string, method: "POST" | "PATCH", body: unknown): Promise<{ ok: boolean; json: ProfileResponse & { error?: string; optionsJSON?: PublicKeyCredentialRequestOptionsJSON } }> {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: response.ok, json: await response.json() };
}

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
                account: toAccount({ ...result, appUserId: result.appUserId, ownerAddress: result.ownerAddress, safeAddress: result.safeAddress }),
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
            set({ account: toAccount(account), status: "ready" });
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
            // Sign-in already succeeded on the server. Best-effort, fire-and-forget:
            // relabel THIS passkey (its own userHandle, just verified) with the
            // handle the server just returned. Never awaited, never an error.
            signalAccountLabel({ rpId: optionsJSON?.rpId, userHandle: response?.response?.userHandle, handle: account.handle, displayName: account.displayName });
            if (myGeneration !== generation) return;
            set({ account: toAccount(account), status: "ready" });
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

        profileBusy: false,
        profileError: null,
        clearProfileError: () => set({ profileError: null }),

        claimHandle: async (handleInput) => {
          const canonical = canonicalizeHandle(handleInput);
          if (!canonical.ok) {
            set({ profileError: canonical.reason });
            return false;
          }
          // Not a session transition, so it takes no new generation — it only
          // refuses to write once one has happened (sign-out, account switch).
          const myGeneration = generation;
          const appUserId = get().account?.appUserId;
          if (!appUserId) return false;
          const stillCurrent = () => myGeneration === generation && get().account?.appUserId === appUserId;
          // The account changed underneath this action: write nothing about it, just stop being busy.
          const abandon = () => {
            set({ profileBusy: false });
            return false;
          };
          const applyProfile = (profile: ProfileResponse) => {
            const account = get().account;
            if (account) set({ account: toAccount({ ...account, handle: profile.handle ?? account.handle, displayName: profile.displayName ?? account.displayName }) });
          };
          set({ profileBusy: true, profileError: null });
          try {
            const prepared = await profileApi("/api/real/account/handle/options", "POST", { handle: canonical.handle });
            if (!stillCurrent()) return abandon();
            if (!prepared.ok || !prepared.json.optionsJSON) {
              // The account already has a name: show it. If it is the very name
              // asked for, an earlier claim's answer was lost — that is success.
              if (prepared.json.handle) applyProfile({ handle: prepared.json.handle });
              const alreadyMine = prepared.json.handle === canonical.handle;
              set({ profileBusy: false, profileError: alreadyMine ? null : (prepared.json.error ?? "Couldn't check that name. Try again.") });
              return alreadyMine;
            }
            const optionsJSON = prepared.json.optionsJSON;
            const response = await performLoginCeremony(optionsJSON);
            if (!stillCurrent()) return abandon();
            const claimed = await profileApi("/api/real/account/handle/claim", "POST", { handle: canonical.handle, response });
            if (claimed.ok && claimed.json.handle) {
              // The claim is already final on the server; the relabel is cosmetic and never awaited.
              signalAccountLabel({ rpId: optionsJSON?.rpId, userHandle: response?.response?.userHandle, handle: claimed.json.handle, displayName: claimed.json.displayName });
            }
            if (!stillCurrent()) return abandon();
            if (!claimed.ok || !claimed.json.handle) {
              if (claimed.json.handle) applyProfile({ handle: claimed.json.handle });
              set({ profileBusy: false, profileError: claimed.json.error ?? "Couldn't save that name. Try again." });
              return false;
            }
            applyProfile(claimed.json);
            set({ profileBusy: false, profileError: null });
            return true;
          } catch (error) {
            if (!stillCurrent()) return abandon();
            set({ profileBusy: false, profileError: isWebAuthnCancellation(error) ? null : "Couldn't save that name. Try again." });
            return false;
          }
        },

        saveDisplayName: async (displayNameInput) => {
          const validation = validateAccountDisplayName(displayNameInput);
          if (!validation.ok) {
            set({ profileError: validation.reason });
            return false;
          }
          const myGeneration = generation;
          const appUserId = get().account?.appUserId;
          if (!appUserId) return false;
          const stillCurrent = () => myGeneration === generation && get().account?.appUserId === appUserId;
          // The account changed underneath this action: write nothing about it, just stop being busy.
          const abandon = () => {
            set({ profileBusy: false });
            return false;
          };
          set({ profileBusy: true, profileError: null });
          try {
            const saved = await profileApi("/api/real/account/profile", "PATCH", { displayName: validation.name });
            if (!stillCurrent()) return abandon();
            if (!saved.ok) {
              set({ profileBusy: false, profileError: saved.json.error ?? "Couldn't save your name. Try again." });
              return false;
            }
            const account = get().account;
            if (account) set({ account: toAccount({ ...account, displayName: saved.json.displayName ?? null }), profileBusy: false, profileError: null });
            else set({ profileBusy: false });
            return true;
          } catch {
            if (!stillCurrent()) return abandon();
            set({ profileBusy: false, profileError: "Couldn't save your name. Try again." });
            return false;
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
