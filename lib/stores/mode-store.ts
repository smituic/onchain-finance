import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type AppMode = "practice" | "real";

export type ModeStore = {
  /**
   * The mode the user last chose. Read it through `selectMode` (or the
   * `useMode` hook), never directly: the Real Mode feature flag is
   * authoritative and can override a persisted "real" back to Practice.
   */
  mode: AppMode;
  /**
   * Whether Real Mode exists in this build. Comes from
   * NEXT_PUBLIC_REAL_MODE_ENABLED at store creation and is not persisted —
   * a build that turns the flag off must win over a browser that remembers
   * Real Mode being on.
   */
  realModeEnabled: boolean;
  /**
   * Whether the user has seen and accepted the one-time Real Mode
   * introduction. Persisted so it appears on the first entry only.
   */
  hasAcknowledgedRealIntro: boolean;
  /** Same explicit-rehydration lifecycle flag as the simulation store. */
  hasHydrated: boolean;
  /** Switches mode. Ignored when asked for Real while Real Mode is disabled. */
  setMode: (mode: AppMode) => void;
  /** Records the intro as seen and enters Real Mode in one step. */
  acknowledgeRealIntro: () => void;
};

export const MODE_STORE_NAME = "onchain-finance:mode";

/** What `partialize` persists: the user's choices, never lifecycle or build config. */
type PersistedModeState = {
  mode: AppMode;
  hasAcknowledgedRealIntro: boolean;
};

/** Reads the build-time feature flag. Defaults to off so a build with no config stays Practice-only. */
export function readRealModeFlag(): boolean {
  return process.env.NEXT_PUBLIC_REAL_MODE_ENABLED === "true";
}

/**
 * The effective application mode. This is the single place the feature
 * flag overrides user state, so no page or component needs its own check.
 */
export function selectMode(store: Pick<ModeStore, "mode" | "realModeEnabled">): AppMode {
  return store.realModeEnabled ? store.mode : "practice";
}

/**
 * @param realModeEnabled injectable feature flag, so tests can exercise
 * both builds without touching process.env.
 */
export function createModeStore({ realModeEnabled = readRealModeFlag() }: { realModeEnabled?: boolean } = {}) {
  const store = create<ModeStore>()(
    persist(
      (set, get) => ({
        mode: "practice",
        realModeEnabled,
        hasAcknowledgedRealIntro: false,
        hasHydrated: false,
        setMode: (mode) => {
          if (mode === "real" && !get().realModeEnabled) return;
          set({ mode });
        },
        acknowledgeRealIntro: () => {
          if (!get().realModeEnabled) return;
          set({ hasAcknowledgedRealIntro: true, mode: "real" });
        },
      }),
      {
        name: MODE_STORE_NAME,
        storage: createJSONStorage(() => localStorage),
        partialize: (store): PersistedModeState => ({
          mode: store.mode,
          hasAcknowledgedRealIntro: store.hasAcknowledgedRealIntro,
        }),
        // Same reasoning as simulation-store.ts: server-first rendering has
        // no localStorage, so the presentation layer rehydrates explicitly
        // after mount and gates mode-dependent UI on `hasHydrated`.
        skipHydration: true,
        version: 0,
      },
    ),
  );

  store.persist.onFinishHydration(() => {
    // A browser that remembers Real Mode from an earlier build must not
    // stay there once the flag is off. Normalise the persisted choice here
    // so the stored value and the effective mode agree, then unblock UI.
    const { mode, realModeEnabled: enabled } = store.getState();
    store.setState({ mode: enabled ? mode : "practice", hasHydrated: true });
  });

  return store;
}

/** The store components use. */
export const useModeStore = createModeStore();

/** The effective mode — Practice whenever Real Mode is disabled in this build. */
export function useMode(): AppMode {
  return useModeStore(selectMode);
}

/** Whether useModeStore has finished explicit rehydration. */
export function useHasModeHydrated(): boolean {
  return useModeStore((s) => s.hasHydrated);
}
