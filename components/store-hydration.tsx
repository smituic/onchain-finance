"use client";

import { useEffect } from "react";
import { useSimulationStore } from "@/lib/stores/simulation-store";
import { useModeStore } from "@/lib/stores/mode-store";
import { useRealAccountStore } from "@/lib/stores/real-account-store";

/**
 * Mounted once in the root layout. Triggers every persisted store's
 * explicit, client-only rehydration from localStorage (see skipHydration in
 * each store). Renders nothing. Mode hydrates first so the Practice/Real
 * boundary settles before any mode-specific screen can appear.
 */
export function StoreHydration() {
  useEffect(() => {
    void useModeStore.persist.rehydrate();
    void useSimulationStore.persist.rehydrate();
    void useRealAccountStore.persist.rehydrate();
  }, []);

  return null;
}
