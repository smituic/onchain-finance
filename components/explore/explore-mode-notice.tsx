"use client";

import { useHasModeHydrated, useMode } from "@/lib/stores/mode-store";
import { Note } from "@/components/shell/note";

/**
 * Explore is mode-independent: every experiment runs on its own separate
 * Practice money (see ARCHITECTURE.md's "Explore sandbox"). In Real Mode
 * that needs saying out loud, so a user never wonders whether an
 * experiment just touched a real account. Renders nothing otherwise.
 */
export function ExploreModeNotice() {
  const hasHydrated = useHasModeHydrated();
  const mode = useMode();

  if (!hasHydrated || mode !== "real") return null;

  return (
    <Note>
      <p>
        You&apos;re in Real Mode, but Explore always uses its own separate Practice money. Nothing here touches a
        real account.
      </p>
    </Note>
  );
}
