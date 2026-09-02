"use client";

import { useEffect } from "react";
import { useSimulationStore } from "@/lib/stores/simulation-store";

/**
 * Mounted once in the root layout. Triggers the store's explicit,
 * client-only rehydration from localStorage (see skipHydration in
 * simulation-store.ts). Renders nothing.
 */
export function SimulationStoreHydration() {
  useEffect(() => {
    void useSimulationStore.persist.rehydrate();
  }, []);

  return null;
}
