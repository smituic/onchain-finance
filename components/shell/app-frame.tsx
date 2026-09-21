"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname.startsWith("/dev/turnkey-poc")) {
    return <div className="min-h-full">{children}</div>;
  }
  return <AppShell>{children}</AppShell>;
}
