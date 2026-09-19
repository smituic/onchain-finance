import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createModeStore,
  MODE_STORE_NAME,
  readRealModeFlag,
  selectMode,
  useHasModeHydrated,
  useMode,
  useModeStore,
} from "@/lib/stores/mode-store";

function seedPersisted(state: { mode: "practice" | "real"; hasAcknowledgedRealIntro: boolean }) {
  localStorage.setItem(MODE_STORE_NAME, JSON.stringify({ state, version: 0 }));
}

describe("mode store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to Practice with the intro not yet acknowledged", () => {
    const store = createModeStore({ realModeEnabled: true });
    expect(store.getState().mode).toBe("practice");
    expect(store.getState().hasAcknowledgedRealIntro).toBe(false);
    expect(store.getState().hasHydrated).toBe(false);
    expect(selectMode(store.getState())).toBe("practice");
  });

  it("reads the feature flag from the environment and defaults it to off", () => {
    // The test environment sets no NEXT_PUBLIC_REAL_MODE_ENABLED, so a
    // build with no configuration stays Practice-only.
    expect(readRealModeFlag()).toBe(false);
  });

  it("switches between modes when Real Mode is enabled", () => {
    const store = createModeStore({ realModeEnabled: true });

    store.getState().setMode("real");
    expect(store.getState().mode).toBe("real");
    expect(selectMode(store.getState())).toBe("real");

    store.getState().setMode("practice");
    expect(store.getState().mode).toBe("practice");
  });

  it("acknowledging the intro records it and enters Real Mode in one step", () => {
    const store = createModeStore({ realModeEnabled: true });

    store.getState().acknowledgeRealIntro();

    expect(store.getState().hasAcknowledgedRealIntro).toBe(true);
    expect(store.getState().mode).toBe("real");
  });

  describe("feature flag is authoritative", () => {
    it("refuses to enter Real Mode when disabled", () => {
      const store = createModeStore({ realModeEnabled: false });

      store.getState().setMode("real");
      store.getState().acknowledgeRealIntro();

      expect(store.getState().mode).toBe("practice");
      expect(store.getState().hasAcknowledgedRealIntro).toBe(false);
      expect(selectMode(store.getState())).toBe("practice");
    });

    it("resolves a persisted Real Mode back to Practice when a later build disables the flag", async () => {
      seedPersisted({ mode: "real", hasAcknowledgedRealIntro: true });

      const store = createModeStore({ realModeEnabled: false });
      await store.persist.rehydrate();

      expect(store.getState().hasHydrated).toBe(true);
      expect(store.getState().mode).toBe("practice");
      expect(selectMode(store.getState())).toBe("practice");
      // The acknowledgement is a fact about the user, not the build — it survives.
      expect(store.getState().hasAcknowledgedRealIntro).toBe(true);
    });

    it("selectMode reports Practice for a 'real' value whenever the flag is off, even before normalisation", () => {
      expect(selectMode({ mode: "real", realModeEnabled: false })).toBe("practice");
      expect(selectMode({ mode: "real", realModeEnabled: true })).toBe("real");
    });
  });

  describe("persistence", () => {
    it("persists only the user's choices, never lifecycle or build state", () => {
      const store = createModeStore({ realModeEnabled: true });
      store.getState().acknowledgeRealIntro();

      const raw = localStorage.getItem(MODE_STORE_NAME);
      expect(raw).not.toBeNull();
      const persisted = JSON.parse(raw as string);

      expect(persisted.state).toEqual({ mode: "real", hasAcknowledgedRealIntro: true });
      expect(Object.keys(persisted.state)).not.toContain("hasHydrated");
      expect(Object.keys(persisted.state)).not.toContain("realModeEnabled");
    });

    it("restores mode and intro acknowledgement only after explicit rehydration", async () => {
      seedPersisted({ mode: "real", hasAcknowledgedRealIntro: true });

      const store = createModeStore({ realModeEnabled: true });
      // skipHydration: a fresh store starts from defaults even though
      // localStorage already has a persisted choice.
      expect(store.getState().mode).toBe("practice");
      expect(store.getState().hasHydrated).toBe(false);

      await store.persist.rehydrate();

      expect(store.getState().hasHydrated).toBe(true);
      expect(store.getState().mode).toBe("real");
      expect(store.getState().hasAcknowledgedRealIntro).toBe(true);
    });

    it("keeps the acknowledgement across a Practice round-trip and a reload", async () => {
      const first = createModeStore({ realModeEnabled: true });
      first.getState().acknowledgeRealIntro();
      first.getState().setMode("practice");

      const second = createModeStore({ realModeEnabled: true });
      await second.persist.rehydrate();

      expect(second.getState().mode).toBe("practice");
      expect(second.getState().hasAcknowledgedRealIntro).toBe(true);
    });

    it("never touches the simulation store's persistence key", () => {
      const store = createModeStore({ realModeEnabled: true });
      store.getState().acknowledgeRealIntro();

      expect(localStorage.getItem("onchain-finance:simulation")).toBeNull();
    });
  });

  describe("hooks on the shared store", () => {
    beforeEach(() => {
      useModeStore.setState({ mode: "practice", realModeEnabled: false, hasAcknowledgedRealIntro: false, hasHydrated: false });
    });

    it("useMode applies the feature flag", () => {
      useModeStore.setState({ mode: "real", realModeEnabled: false, hasHydrated: true });
      expect(renderHook(() => useMode()).result.current).toBe("practice");

      useModeStore.setState({ realModeEnabled: true });
      expect(renderHook(() => useMode()).result.current).toBe("real");
    });

    it("useHasModeHydrated reflects explicit rehydration", async () => {
      expect(renderHook(() => useHasModeHydrated()).result.current).toBe(false);
      await useModeStore.persist.rehydrate();
      expect(renderHook(() => useHasModeHydrated()).result.current).toBe(true);
    });
  });
});
