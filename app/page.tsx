import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">onchain-finance</h1>
      <p className="max-w-sm text-muted-foreground">
        Scaffold placeholder — real UI work starts once DESIGN.md&apos;s visual
        identity is decided.
      </p>
      <Button>Scaffold smoke test</Button>
    </main>
  );
}
