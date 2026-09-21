import type { Metadata } from "next";
import { StoreHydration } from "@/components/store-hydration";
import { AppFrame } from "@/components/shell/app-frame";
import "./globals.css";

export const metadata: Metadata = {
  title: "onchain-finance",
  description: "Make on-chain finance feel like normal money.",
};

// Dark is the default (and only) appearance for now: a temporary neutral
// treatment built from the tokens already in globals.css, not a brand
// decision. DESIGN.md still lists light-vs-dark default as undecided.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">
        <StoreHydration />
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
