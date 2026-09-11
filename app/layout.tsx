import type { Metadata } from "next";
import { SimulationStoreHydration } from "@/components/simulation-store-hydration";
import { AppShell } from "@/components/shell/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "onchain-finance",
  description: "Make on-chain finance feel like normal money.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">
        <SimulationStoreHydration />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
