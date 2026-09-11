import type { ReactNode } from "react";

/**
 * A calm, non-alarming block used for two things: explaining a concept in
 * context, and being honest about what a screen can't do yet. Visually
 * distinct from an error, per DESIGN.md's note on teaching moments.
 */
export function Note({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-muted/60 px-4 py-3.5">
      {title ? <p className="text-sm font-medium">{title}</p> : null}
      <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}
