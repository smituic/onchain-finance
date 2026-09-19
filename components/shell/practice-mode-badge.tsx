/**
 * The quiet Practice Mode pill shown in the app header when Real Mode is
 * not enabled for this build (see ModeSwitch). Deliberately a pill rather
 * than a warning banner: simulated money is the normal state of the
 * product, not an error.
 */
export function PracticeModeBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-foreground/40" />
      Practice Mode
    </span>
  );
}
