"use client";

import type { ReactNode } from "react";
import { useHasModeHydrated, useMode, useModeStore } from "@/lib/stores/mode-store";

/**
 * The Practice / Real boundary at the page level. Each page hands in its
 * two parallel presentations and this picks one; the two never share an
 * engine, only presentation primitives (see ARCHITECTURE.md).
 *
 * Hydration-safe: with Real Mode disabled for this build there is exactly
 * one possible outcome, so `practice` renders immediately — server-side
 * too — exactly as before Real Mode existed. Otherwise a neutral skeleton
 * holds the page until the persisted mode is known, so a Real Mode user
 * never sees Practice flash first. The feature flag itself is honoured
 * inside `useMode`, not here.
 */
export function ByMode({ practice, real }: { practice: ReactNode; real: ReactNode }) {
  const realModeEnabled = useModeStore((s) => s.realModeEnabled);
  const hasHydrated = useHasModeHydrated();
  const mode = useMode();

  if (!realModeEnabled) return <>{practice}</>;
  if (!hasHydrated) return <ModeSkeleton />;
  return <>{mode === "real" ? real : practice}</>;
}

function ModeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" data-testid="mode-skeleton" className="flex flex-col gap-8 pt-2">
      <div className="flex flex-col gap-2">
        <div className="h-4 w-28 animate-pulse rounded bg-muted" />
        <div className="h-11 w-52 animate-pulse rounded-lg bg-muted" />
      </div>
      <div className="h-32 animate-pulse rounded-xl bg-muted/60" />
    </div>
  );
}
