import { cn } from "@/lib/utils";

/**
 * A label/value line — the workhorse of every balance list in the product.
 * `loading` renders a placeholder instead of the value, so a screen never
 * shows an un-hydrated default balance as if it were the user's own.
 */
export function ValueRow({
  label,
  value,
  hint,
  loading = false,
  muted = false,
}: {
  label: string;
  value: string;
  hint?: string;
  loading?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      data-testid={`value-row-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className="flex items-baseline justify-between gap-4 py-2.5"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm">{label}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </div>
      {loading ? (
        <div aria-hidden="true" className="h-4 w-20 animate-pulse rounded bg-muted" />
      ) : (
        <span
          className={cn("shrink-0 text-sm font-medium tabular-nums", muted && "text-muted-foreground")}
        >
          {value}
        </span>
      )}
    </div>
  );
}
