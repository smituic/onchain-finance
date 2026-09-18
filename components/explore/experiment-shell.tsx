"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { PRODUCT_AREAS_BY_ID } from "@/lib/product-areas";
import { Button } from "@/components/ui/button";
import type { Experiment } from "@/components/explore/experiments";

/**
 * The shared frame every Explore experiment sits in: a way back, the
 * question, the one-line hook, the sandbox itself, then reset and an
 * optional link to the full feature. Deliberately not a wizard or a
 * module — the sandbox (children) stays mounted the whole time and updates
 * in place as the user acts on it.
 */
export function ExperimentShell({
  experiment,
  onReset,
  canReset,
  children,
}: {
  experiment: Experiment;
  onReset: () => void;
  canReset: boolean;
  children: ReactNode;
}) {
  const area = PRODUCT_AREAS_BY_ID[experiment.areaId];

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/explore"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Explore
      </Link>

      <header className="flex flex-col gap-1.5 pb-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{experiment.question}</h1>
        <p className="text-sm text-muted-foreground">{experiment.hook}</p>
      </header>

      <p className="text-xs text-muted-foreground">
        This experiment uses separate Practice money — your main balances won&apos;t change.
      </p>

      {children}

      <div className="flex flex-col gap-3 pt-2">
        {canReset ? (
          <Button variant="outline" className="h-11 w-full" onClick={onReset}>
            Reset experiment
          </Button>
        ) : null}
        <Link
          href={area.href}
          className="text-center text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Open full {area.label}
        </Link>
      </div>
    </div>
  );
}
