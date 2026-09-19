import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ModeSwitch } from "@/components/shell/mode-switch";
import { useModeStore } from "@/lib/stores/mode-store";

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

const practiceOption = () => screen.getByRole("button", { name: "Practice" });
const realOption = () => screen.getByRole("button", { name: "Real" });
const intro = () => screen.queryByRole("alertdialog");

describe("ModeSwitch", () => {
  beforeEach(() => resetModeStore());

  it("offers Practice and Real as an accessible pressed-state group, with Practice selected by default", () => {
    render(<ModeSwitch />);

    expect(screen.getByRole("group", { name: "Mode" })).toBeInTheDocument();
    expect(practiceOption()).toHaveAttribute("aria-pressed", "true");
    expect(realOption()).toHaveAttribute("aria-pressed", "false");
    expect(intro()).not.toBeInTheDocument();
  });

  it("selects neither option until the mode store has hydrated, so Practice never flashes first", () => {
    resetModeStore({ hasHydrated: false });
    render(<ModeSwitch />);

    expect(screen.getByRole("group", { name: "Mode" })).toHaveAttribute("aria-busy", "true");
    expect(practiceOption()).toHaveAttribute("aria-pressed", "false");
    expect(realOption()).toHaveAttribute("aria-pressed", "false");
    expect(practiceOption()).toBeDisabled();
    expect(realOption()).toBeDisabled();
  });

  it("opens the introduction on the first attempt to enter Real Mode, without switching yet", () => {
    render(<ModeSwitch />);

    fireEvent.click(realOption());

    expect(intro()).toBeInTheDocument();
    expect(screen.getByText("Entering Real Mode")).toBeInTheDocument();
    expect(screen.getByText(/development-only version that runs on a test network/)).toBeInTheDocument();
    expect(screen.getByText(/no real dollars are involved/)).toBeInTheDocument();
    expect(useModeStore.getState().mode).toBe("practice");
  });

  it("cancelling the introduction stays in Practice and remembers nothing", () => {
    render(<ModeSwitch />);

    fireEvent.click(realOption());
    fireEvent.click(screen.getByRole("button", { name: "Stay in Practice" }));

    expect(intro()).not.toBeInTheDocument();
    expect(useModeStore.getState().mode).toBe("practice");
    expect(useModeStore.getState().hasAcknowledgedRealIntro).toBe(false);
    expect(practiceOption()).toHaveAttribute("aria-pressed", "true");
  });

  it("confirming the introduction enters Real Mode and records the acknowledgement", () => {
    render(<ModeSwitch />);

    fireEvent.click(realOption());
    fireEvent.click(screen.getByRole("button", { name: "Continue to Real Mode" }));

    expect(intro()).not.toBeInTheDocument();
    expect(useModeStore.getState().mode).toBe("real");
    expect(useModeStore.getState().hasAcknowledgedRealIntro).toBe(true);
    expect(realOption()).toHaveAttribute("aria-pressed", "true");
  });

  it("does not show the introduction again once it has been acknowledged", () => {
    render(<ModeSwitch />);

    fireEvent.click(realOption());
    fireEvent.click(screen.getByRole("button", { name: "Continue to Real Mode" }));
    fireEvent.click(practiceOption());
    expect(useModeStore.getState().mode).toBe("practice");

    fireEvent.click(realOption());

    expect(intro()).not.toBeInTheDocument();
    expect(useModeStore.getState().mode).toBe("real");
  });

  it("skips the introduction for a user whose acknowledgement was persisted earlier", () => {
    resetModeStore({ hasAcknowledgedRealIntro: true });
    render(<ModeSwitch />);

    fireEvent.click(realOption());

    expect(intro()).not.toBeInTheDocument();
    expect(useModeStore.getState().mode).toBe("real");
  });

  it("keeps the plain Practice Mode badge, and no switch, when Real Mode is disabled for the build", () => {
    resetModeStore({ realModeEnabled: false });
    render(<ModeSwitch />);

    expect(screen.getByText("Practice Mode")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Real" })).not.toBeInTheDocument();
  });
});
