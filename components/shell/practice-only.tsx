"use client";

import { useModeStore } from "@/lib/stores/mode-store";
import { PRODUCT_AREAS_BY_ID, type ProductAreaId } from "@/lib/product-areas";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shell/page-header";

/**
 * What an area shows in Real Mode before its real implementation exists.
 * An intentional product state, not an error: Real Mode is arriving one
 * area at a time, starting with Pay, and Practice keeps working for all of
 * them. "Try it in Practice" switches mode and leaves the user right here,
 * on the same area, now rendered by its Practice view.
 */
export function PracticeOnly({ areaId }: { areaId: ProductAreaId }) {
  const area = PRODUCT_AREAS_BY_ID[areaId];
  const setMode = useModeStore((s) => s.setMode);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={area.label} purpose={area.purpose} />

      <section
        data-testid="practice-only"
        className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center"
      >
        <p className="text-sm font-medium">{area.label} is Practice-only for now.</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Real Mode is being built one area at a time, starting with Pay. Everything {area.label} does still works
          with Practice money.
        </p>
        <Button variant="outline" className="mt-2 h-11" onClick={() => setMode("practice")}>
          Try it in Practice
        </Button>
      </section>
    </div>
  );
}
