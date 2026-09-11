"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A question the user can tap to answer — the product's progressive
 * disclosure primitive. The plain-language consequence stays on the screen;
 * the mechanism and the term for it live in here.
 */
export function Expander({ question, children }: { question: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();

  return (
    <div className="flex flex-col">
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto justify-between p-0 text-left text-foreground"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((value) => !value)}
      >
        {question}
        <ChevronDown aria-hidden="true" className={expanded ? "size-4 rotate-180" : "size-4"} />
      </Button>
      {expanded ? (
        <div id={id} className="mt-2 flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  );
}
