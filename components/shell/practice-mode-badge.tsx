/**
 * The one consistent Practice Mode treatment, shown in the app header on
 * every screen. Deliberately a quiet pill rather than a warning banner:
 * simulated money is the normal state of the product today, not an error.
 * When Real Mode exists, the mode switch belongs in this slot.
 */
export function PracticeModeBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-foreground/40" />
      Practice Mode
    </span>
  );
}
