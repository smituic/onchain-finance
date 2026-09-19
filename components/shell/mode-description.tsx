"use client";

import { useHasModeHydrated, useMode, useModeStore } from "@/lib/stores/mode-store";

const COPY = {
  practice: "You're in Practice Mode. Every balance here is simulated — nothing is real money.",
  real: "You're in Real Mode. This is an early test-network build — no real dollars are involved yet.",
} as const;

/**
 * The one-line description of the current mode in the desktop sidebar.
 * With Real Mode disabled it renders the Practice sentence immediately, as
 * it always has; otherwise it waits for the mode store so it never
 * describes the wrong mode for a moment.
 */
export function ModeDescription({ className }: { className?: string }) {
  const realModeEnabled = useModeStore((s) => s.realModeEnabled);
  const hasHydrated = useHasModeHydrated();
  const mode = useMode();

  const text = !realModeEnabled ? COPY.practice : hasHydrated ? COPY[mode] : null;

  return (
    <p className={className} aria-hidden={text === null || undefined}>
      {text ?? "\u00a0"}
    </p>
  );
}
