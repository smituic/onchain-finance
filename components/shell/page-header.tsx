export function PageHeader({ title, purpose }: { title: string; purpose: string }) {
  return (
    <header className="flex flex-col gap-1.5 pt-2 pb-7">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{purpose}</p>
    </header>
  );
}
