import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ByMode } from "@/components/shell/by-mode";
import { MODE_STORE_NAME, useModeStore } from "@/lib/stores/mode-store";

function resetModeStore(overrides: Partial<ReturnType<typeof useModeStore.getState>> = {}) {
  localStorage.clear();
  useModeStore.setState({
    mode: "practice",
    realModeEnabled: true,
    hasAcknowledgedRealIntro: false,
    hasHydrated: true,
    ...overrides,
  });
}

/** What a browser that last used Real Mode has in localStorage. */
function seedPersistedReal() {
  localStorage.setItem(
    MODE_STORE_NAME,
    JSON.stringify({ state: { mode: "real", hasAcknowledgedRealIntro: true }, version: 0 }),
  );
}

function renderByMode() {
  return render(<ByMode practice={<p>Practice content</p>} real={<p>Real content</p>} />);
}

describe("ByMode", () => {
  beforeEach(() => resetModeStore());

  it("renders the Practice presentation in Practice Mode", () => {
    renderByMode();
    expect(screen.getByText("Practice content")).toBeInTheDocument();
    expect(screen.queryByText("Real content")).not.toBeInTheDocument();
  });

  it("renders the Real presentation in Real Mode", () => {
    resetModeStore({ mode: "real" });
    renderByMode();
    expect(screen.getByText("Real content")).toBeInTheDocument();
    expect(screen.queryByText("Practice content")).not.toBeInTheDocument();
  });

  it("shows a neutral skeleton — neither mode — until the mode store has hydrated", () => {
    resetModeStore({ hasHydrated: false });
    renderByMode();

    expect(screen.getByTestId("mode-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("Practice content")).not.toBeInTheDocument();
    expect(screen.queryByText("Real content")).not.toBeInTheDocument();
  });

  it("swaps to the persisted mode once hydration finishes, with no Practice render in between", async () => {
    resetModeStore({ hasHydrated: false });
    seedPersistedReal();
    renderByMode();
    expect(screen.getByTestId("mode-skeleton")).toBeInTheDocument();

    await act(async () => {
      await useModeStore.persist.rehydrate();
    });

    expect(screen.getByText("Real content")).toBeInTheDocument();
    expect(screen.queryByText("Practice content")).not.toBeInTheDocument();
  });

  it("renders Practice immediately, without a skeleton, when Real Mode is disabled for the build", () => {
    resetModeStore({ realModeEnabled: false, hasHydrated: false });
    renderByMode();

    expect(screen.getByText("Practice content")).toBeInTheDocument();
    expect(screen.queryByTestId("mode-skeleton")).not.toBeInTheDocument();
  });

  it("falls back to Practice when the browser remembers Real Mode but the build has it disabled", async () => {
    resetModeStore({ realModeEnabled: false, hasHydrated: false });
    seedPersistedReal();

    renderByMode();
    await act(async () => {
      await useModeStore.persist.rehydrate();
    });

    expect(useModeStore.getState().hasHydrated).toBe(true);
    expect(screen.getByText("Practice content")).toBeInTheDocument();
    expect(screen.queryByText("Real content")).not.toBeInTheDocument();
    expect(useModeStore.getState().mode).toBe("practice");
  });
});
