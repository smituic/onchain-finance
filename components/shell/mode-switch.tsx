"use client";

import { useState } from "react";
import { useHasModeHydrated, useMode, useModeStore, type AppMode } from "@/lib/stores/mode-store";
import { PracticeModeBadge } from "@/components/shell/practice-mode-badge";
import { RealModeIntro } from "@/components/shell/real-mode-intro";
import { cn } from "@/lib/utils";

/**
 * The Practice / Real control in the app header. Two pressed-state buttons
 * rather than a switch: both modes are named, neither is "on" or "off".
 * Before the mode store has rehydrated, neither option is pressed, so a
 * user who left the app in Real Mode never sees Practice flash first.
 *
 * When Real Mode is disabled for this build, the header keeps the quiet
 * Practice Mode badge it has always had — the switch simply doesn't exist.
 */
export function ModeSwitch() {
  const realModeEnabled = useModeStore((s) => s.realModeEnabled);
  const hasHydrated = useHasModeHydrated();
  const mode = useMode();
  const hasAcknowledgedRealIntro = useModeStore((s) => s.hasAcknowledgedRealIntro);
  const setMode = useModeStore((s) => s.setMode);
  const acknowledgeRealIntro = useModeStore((s) => s.acknowledgeRealIntro);
  const [introOpen, setIntroOpen] = useState(false);

  if (!realModeEnabled) return <PracticeModeBadge />;

  function choose(next: AppMode) {
    if (next === "real" && !hasAcknowledgedRealIntro) {
      setIntroOpen(true);
      return;
    }
    setMode(next);
  }

  return (
    <>
      <div
        role="group"
        aria-label="Mode"
        aria-busy={!hasHydrated || undefined}
        className="inline-flex items-center rounded-full bg-muted p-0.5 text-xs font-medium"
      >
        <ModeOption
          label="Practice"
          pressed={hasHydrated && mode === "practice"}
          disabled={!hasHydrated}
          onClick={() => choose("practice")}
        />
        <ModeOption
          label="Real"
          pressed={hasHydrated && mode === "real"}
          disabled={!hasHydrated}
          onClick={() => choose("real")}
        />
      </div>
      <RealModeIntro
        open={introOpen}
        onConfirm={() => {
          acknowledgeRealIntro();
          setIntroOpen(false);
        }}
        onCancel={() => setIntroOpen(false)}
      />
    </>
  );
}

function ModeOption({
  label,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        pressed ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
