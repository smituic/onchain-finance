import type { ReactNode } from "react";
import Link from "next/link";
import { AppSidebarNav, AppTabBarNav } from "@/components/shell/app-nav";
import { ModeDescription } from "@/components/shell/mode-description";
import { ModeSwitch } from "@/components/shell/mode-switch";

/**
 * The frame every screen sits in: a sidebar on desktop, a tab bar on mobile,
 * and one column of content sized for a phone at any width — larger screens
 * get more room around the product, not a wider dashboard. The header
 * carries the Practice / Real mode control (see ModeSwitch); which mode a
 * page renders is decided by the page itself via ByMode.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col md:flex-row">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col justify-between border-r border-border px-4 py-6 md:flex">
        <div className="flex flex-col gap-8">
          <Link href="/" className="px-3 font-heading text-base font-semibold tracking-tight">
            onchain
          </Link>
          <AppSidebarNav />
        </div>
        <ModeDescription className="px-3 text-xs leading-relaxed text-muted-foreground" />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between px-5 md:justify-end md:px-8">
          <Link href="/" className="font-heading text-base font-semibold tracking-tight md:hidden">
            onchain
          </Link>
          <ModeSwitch />
        </header>

        <main className="mx-auto w-full max-w-xl flex-1 px-5 pb-28 md:px-8 md:pb-16">{children}</main>
      </div>

      <AppTabBarNav />
    </div>
  );
}
